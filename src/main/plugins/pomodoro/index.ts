// 专注插件（主进程）：番茄钟会话的落库与统计。
//
// 渲染层按 wall clock 显示剩余，主进程统一结算和衔接下一阶段。
// 这样休眠、关窗、重启都不会让计时器和数据库对不上：没写 end_at 的会话就是没走完的，
// pausedAt 非空就是停在那儿的。
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { readPluginSetting, writePluginSetting } from '../../db/plugins.ts'
import { applyExternalPetReaction, applyExternalPetSay } from '../../pet/controller'
import { emitPluginEvent } from '../index.ts'
import { getProfile, getTask, listAppSwitchesSince, listWorkRecords } from '../../db'
import { callModel } from '../../parser'
import { localNowSec } from '@shared/parsing'
import { dayKey } from '@shared/work-report'
import {
  DEFAULT_PREFS,
  RANGE_DAYS,
  actualMinutes,
  breakdownByTask,
  byHour,
  byWeekday,
  dayStats,
  nextPhase,
  normalizePrefs,
  pausedMsAfterResume,
  rangeByTask,
  rangeStats,
  remainingSeconds,
  type PomodoroKind,
  type PomodoroPrefs,
  type PomodoroPhase,
  type PomodoroRuntime,
  type DailyGoal,
  type PomodoroSession,
  type StatsRange
} from '@shared/pomodoro'
import {
  buildRoundEvidence,
  buildRoundReviewPrompt,
  hasEnoughEvidence
} from '@shared/pomodoro-review'
import type { AchievementCounter, PluginMainModule } from '../types.ts'

interface SessionRow {
  id: string
  start_at: string
  end_at: string | null
  minutes: number
  kind: string
  completed: number
  paused_ms: number
  paused_at: string | null
  block_id: string | null
  task_id: string | null
  task_title: string | null
  note: string | null
  review: string | null
}

function toSession(r: SessionRow): PomodoroSession {
  return {
    id: r.id,
    startAt: r.start_at,
    endAt: r.end_at,
    minutes: r.minutes,
    kind: r.kind === 'break' ? 'break' : 'focus',
    completed: !!r.completed,
    pausedMs: r.paused_ms ?? 0,
    pausedAt: r.paused_at,
    blockId: r.block_id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    note: r.note,
    review: r.review
  }
}

function listSince(fromDate: string): PomodoroSession[] {
  return (
    getDb()
      .prepare('SELECT * FROM p_pomodoro_session WHERE start_at >= ? ORDER BY start_at')
      .all(fromDate) as SessionRow[]
  ).map(toSession)
}

function getSession(id: string): PomodoroSession | null {
  const row = getDb().prepare('SELECT * FROM p_pomodoro_session WHERE id = ?').get(id) as
    | SessionRow
    | undefined
  return row ? toSession(row) : null
}

function readPrefs(): PomodoroPrefs {
  const raw = readPluginSetting('pomodoro', 'prefs')
  if (!raw) return DEFAULT_PREFS
  try {
    return normalizePrefs(JSON.parse(raw) as Partial<PomodoroPrefs>)
  } catch {
    return DEFAULT_PREFS
  }
}

/** 区间内每天一行，缺的日子补零——图表要连续的横轴。 */
function dailySeries(
  sessions: PomodoroSession[],
  fromDate: string,
  span: number,
  goal: DailyGoal
): { date: string; rounds: number; focusMinutes: number; hitGoal: boolean }[] {
  const out: { date: string; rounds: number; focusMinutes: number; hitGoal: boolean }[] = []
  const base = new Date(`${fromDate}T12:00:00`).getTime()
  for (let i = 0; i < span; i++) {
    const date = dayKey(new Date(base + i * 86_400_000))
    const s = dayStats(sessions, date, goal)
    // 达标与否按目标口径判，不再固定看轮数
    out.push({ date, rounds: s.rounds, focusMinutes: s.focusMinutes, hitGoal: s.goalProgress >= 1 })
  }
  return out
}

/**
 * 到点结算。**必须在主进程做**：计时器原本跑在专注页里，用户切走页面或关掉窗口，
 * 那一轮到点就不会结算，桌宠也不会响——这是渲染层计时的必然后果，不是偶发。
 * 这里按 wall clock 排一个定时器，到点由主进程收尾并播报。
 */
let roundTimer: ReturnType<typeof setTimeout> | null = null
let pendingNext: PomodoroPhase | null = null
interface FocusContext {
  blockId: string | null
  taskId: string | null
  taskTitle: string | null
}
let pendingFocusContext: FocusContext | null = null
const CONTINUATION_KEY = 'continuation'

function clearContinuation(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(`plugin:pomodoro:${CONTINUATION_KEY}`)
}

function continuationFor(breakSessionId: string): FocusContext | null {
  const raw = readPluginSetting('pomodoro', CONTINUATION_KEY)
  if (!raw) return null
  let context: FocusContext & { breakSessionId: string }
  try { context = JSON.parse(raw) } catch { return null }
  if (!context || context.breakSessionId !== breakSessionId) return null
  const taskId = context.taskId && getTask(context.taskId) ? context.taskId : null
  const hasBlocks = context.blockId && getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'p_timeblock_block'").get()
  const blockId = hasBlocks && getDb().prepare('SELECT id FROM p_timeblock_block WHERE id = ?').get(context.blockId)
    ? context.blockId : null
  return { blockId, taskId, taskTitle: context.taskId && !taskId ? null : context.taskTitle }
}

function clearRoundTimer(): void {
  if (roundTimer) clearTimeout(roundTimer)
  roundTimer = null
}

function runningRow(): SessionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL ORDER BY start_at DESC LIMIT 1')
    .get() as SessionRow | undefined
}

function startSession(
  kind: PomodoroKind,
  minutes: number,
  blockId?: string | null,
  taskId?: string | null,
  taskTitle?: string | null
): PomodoroSession {
  const running = runningRow()
  if (running) return toSession(running)
  const continuation = kind === 'break' && pendingNext?.kind === 'break' ? pendingFocusContext : null
  const id = randomUUID()
  getDb().prepare(`INSERT INTO p_pomodoro_session
    (id, start_at, end_at, minutes, kind, completed, paused_ms, paused_at, block_id, task_id, task_title, note)
    VALUES (?, ?, NULL, ?, ?, 0, 0, NULL, ?, ?, ?, NULL)`)
    .run(id, localNowSec(), Math.max(1, Math.round(minutes)), kind,
      kind === 'focus' ? blockId ?? null : null,
      kind === 'focus' ? taskId ?? null : null,
      kind === 'focus' ? taskTitle ?? null : null)
  if (continuation) {
    writePluginSetting('pomodoro', CONTINUATION_KEY, JSON.stringify({ breakSessionId: id, ...continuation }))
  } else clearContinuation()
  pendingNext = null
  pendingFocusContext = null
  scheduleRoundEnd()
  return getSession(id)!
}

/** 给当前在跑的这一轮排定时器；暂停中或没有在跑的就不排。 */
function scheduleRoundEnd(): void {
  clearRoundTimer()
  const row = runningRow()
  if (!row) return
  const s = toSession(row)
  if (s.pausedAt) return // 暂停中不计时，恢复时会重排
  // +250ms 容差：避免定时器早于整秒触发时算出还剩 1 秒又空转一轮
  const ms = remainingSeconds(s, Date.now()) * 1000 + 250
  roundTimer = setTimeout(() => completeRound(s.id), Math.max(0, ms))
}

/** 到点收尾：落库 → 桌宠播报 → 发插件事件 → 通知渲染层。 */
function completeRound(id: string): void {
  const s = getSession(id)
  if (!s || s.endAt) return // 渲染层可能已经结算过，别记两次
  if (s.pausedAt || remainingSeconds(s, Date.now()) > 0) return scheduleRoundEnd() // 被恢复/改过，重排

  // 重启或休眠恢复可能晚于截止，离线等待不计入实际专注。
  const endedAt = new Date(s.startAt).getTime() + s.minutes * 60_000 + Math.max(0, s.pausedMs)
  finishRound(s, true, endedAt)
}

function finishRound(s: PomodoroSession, completed: boolean, endedAt: number): void {
  clearRoundTimer()
  const endDate = new Date(endedAt)
  const endAt = `${dayKey(endDate)}T${endDate.toTimeString().slice(0, 8)}`
  getDb()
    .prepare('UPDATE p_pomodoro_session SET end_at = ?, completed = ?, paused_ms = ?, paused_at = NULL WHERE id = ?')
    .run(endAt, completed ? 1 : 0, pausedMsAfterResume(s, endedAt), s.id)

  if (!completed) {
    pendingNext = null
    pendingFocusContext = null
    clearContinuation()
    return
  }

  const prefs = readPrefs()
  const today = dayKey(new Date(s.startAt))
  const stats = dayStats(listSince(today), today, prefs.dailyGoal)
  const next = nextPhase(s.kind, stats.rounds, prefs)
  const context: FocusContext | null = s.kind === 'focus'
    ? { blockId: s.blockId, taskId: s.taskId, taskTitle: s.taskTitle }
    : continuationFor(s.id)
  pendingNext = next
  pendingFocusContext = context
  if (prefs.autoStart) startSession(next.kind, next.minutes, context?.blockId, context?.taskId, context?.taskTitle)

  if (s.kind === 'focus') {
    applyExternalPetReaction('success', { showMessage: false })
    applyExternalPetSay(
      s.taskTitle
        ? `「${s.taskTitle}」这一轮完成了，歇 ${next.minutes} 分钟吧`
        : `一轮专注完成了，歇 ${next.minutes} 分钟吧`,
      'success',
      { durationMs: 12_000 }
    )
    // 发出去就不管了：谁在听、有没有人听，与「专注」无关
    emitPluginEvent('pomodoro', 'round-completed', {
      sessionId: s.id,
      blockId: s.blockId,
      taskId: s.taskId,
      taskTitle: s.taskTitle,
      minutes: s.minutes,
      actualMinutes: actualMinutes(s, endedAt),
      startAt: s.startAt,
      date: today
    })
  } else {
    applyExternalPetSay(prefs.autoStart ? `休息结束，开始下一轮专注 ${next.minutes} 分钟` : '休息结束，接着来一轮？', 'waiting', { durationMs: 12_000 })
    emitPluginEvent('pomodoro', 'break-completed', { sessionId: s.id, date: today })
  }
}

const initTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p_pomodoro_session (
      id TEXT PRIMARY KEY,
      start_at TEXT NOT NULL,
      end_at TEXT,
      minutes INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'focus',
      completed INTEGER NOT NULL DEFAULT 0,
      block_id TEXT,
      task_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_p_pomodoro_start ON p_pomodoro_session(start_at);
  `)
  // 增量迁移：暂停、任务标题快照与备注是后加的，只加列，旧行取默认值。
  const cols = (db.prepare('PRAGMA table_info(p_pomodoro_session)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!cols.includes('paused_ms'))
    db.exec('ALTER TABLE p_pomodoro_session ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0')
  if (!cols.includes('paused_at')) db.exec('ALTER TABLE p_pomodoro_session ADD COLUMN paused_at TEXT')
  if (!cols.includes('task_title')) db.exec('ALTER TABLE p_pomodoro_session ADD COLUMN task_title TEXT')
  if (!cols.includes('note')) db.exec('ALTER TABLE p_pomodoro_session ADD COLUMN note TEXT')
  if (!cols.includes('review')) db.exec('ALTER TABLE p_pomodoro_session ADD COLUMN review TEXT')
}

const pomodoro: PluginMainModule = {
  id: 'pomodoro',
  initTables,

  // 启动或启用时重挂定时器：应用重启后那一轮还在跑，到点照样会响
  init: () => scheduleRoundEnd(),
  dispose: () => {
    clearRoundTimer()
    pendingNext = null
    pendingFocusContext = null
  },

  handlers: {
    prefs: () => readPrefs(),

    'prefs-save': (patch: Partial<PomodoroPrefs>) => {
      const next = normalizePrefs({ ...readPrefs(), ...patch })
      writePluginSetting('pomodoro', 'prefs', JSON.stringify(next))
      return next
    },

    start: startSession,

    runtime: (): PomodoroRuntime => {
      const row = runningRow()
      return { running: row ? toSession(row) : null, next: pendingNext }
    },

    'dismiss-next': () => {
      pendingNext = null
      pendingFocusContext = null
      clearContinuation()
      return true
    },

    pause: (id: string) => {
      const s = getSession(id)
      if (!s || s.pausedAt || s.endAt) return s
      getDb().prepare('UPDATE p_pomodoro_session SET paused_at = ? WHERE id = ?').run(localNowSec(), id)
      clearRoundTimer() // 暂停期间不该到点
      return getSession(id)
    },

    resume: (id: string) => {
      const s = getSession(id)
      if (!s || !s.pausedAt || s.endAt) return s
      getDb()
        .prepare('UPDATE p_pomodoro_session SET paused_ms = ?, paused_at = NULL WHERE id = ?')
        .run(pausedMsAfterResume(s, Date.now()), id)
      scheduleRoundEnd()
      return getSession(id)
    },

    finish: (id: string, completed: boolean) => {
      const s = getSession(id)
      if (!s) return false
      if (!s.endAt) finishRound(s, completed, Date.now())
      return true
    },

    /** 给某一轮补一句「做了什么」。 */
    note: (id: string, note: string) => {
      getDb()
        .prepare('UPDATE p_pomodoro_session SET note = ? WHERE id = ?')
        .run(String(note ?? '').slice(0, 200) || null, id)
      return true
    },

    delete: (id: string) => {
      getDb().prepare('DELETE FROM p_pomodoro_session WHERE id = ?').run(id)
      return true
    },

    // 插件借用核心服务的例子：结束播报走桌宠气泡，而不是自己弹一个窗。
    // 用户把桌宠关了或调成安静，这里自然就不响——不需要插件自己再判一遍。
    say: (message: string) => {
      applyExternalPetSay(String(message).slice(0, 60))
      return true
    },

    /** 未写 end_at 的会话——重启后用来恢复「刚才那轮还在跑（或停着）」。 */
    running: () => {
      const row = getDb()
        .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL ORDER BY start_at DESC LIMIT 1')
        .get() as SessionRow | undefined
      return row ? toSession(row) : null
    },

    today: () => {
      const today = dayKey(new Date())
      const sessions = listSince(today)
      const prefs = readPrefs()
      return {
        today,
        sessions: sessions.filter((s) => s.kind === 'focus').reverse(),
        stats: dayStats(sessions, today, prefs.dailyGoal),
        byTask: breakdownByTask(sessions, today)
      }
    },

    /**
     * 生成一轮的复盘。事实（切换次数、短停留占比、打断判定）全在本地算好，
     * 模型只负责组织语言和给建议——让它自己数会数错，数错的复盘比没有更糟。
     * 复盘**不入库**，交给渲染层问用户保留还是丢弃。
     */
    review: async (id: string) => {
      const s = getSession(id)
      if (!s || !s.endAt) return { ok: false, error: '这一轮还没结束' }
      const profile = getProfile()
      if (!profile) return { ok: false, error: '尚未完成用户档案设置' }

      const day = dayKey(new Date(s.startAt))
      const evidence = buildRoundEvidence({
        from: s.startAt,
        to: s.endAt,
        minutes: s.minutes,
        actualMinutes: actualMinutes(s, new Date(s.endAt).getTime()),
        taskTitle: s.taskTitle,
        paused: s.pausedMs > 0,
        switches: listAppSwitchesSince(day),
        records: listWorkRecords(day)
      })
      // 屏幕感知没开时证据是空的，硬生成只会得到一段编造的空话
      if (!hasEnoughEvidence(evidence))
        return { ok: false, error: '这一轮没采到足够的活动记录，写不出有依据的复盘' }

      try {
        const { instructions, text } = buildRoundReviewPrompt(profile.name, evidence)
        const output = await callModel(
          instructions,
          [{ role: 'user', content: [{ type: 'input_text', text }] }],
          'parse_text'
        )
        const content = output.trim().replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim()
        if (!content) return { ok: false, error: '模型没有输出' }
        return { ok: true, review: content, evidence }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    /** 用户点「保留」才落库；丢弃就什么都不做。 */
    'save-review': (id: string, review: string) => {
      getDb()
        .prepare('UPDATE p_pomodoro_session SET review = ? WHERE id = ?')
        .run(String(review ?? '').slice(0, 1000) || null, id)
      return true
    },

    'clear-review': (id: string) => {
      getDb().prepare('UPDATE p_pomodoro_session SET review = NULL WHERE id = ?').run(id)
      return true
    },

    /** 周/月/年的完整统计：总量、分布、按任务、按时段。 */
    stats: (range: StatsRange) => {
      const span = RANGE_DAYS[range] ?? RANGE_DAYS.week
      const toDate = dayKey(new Date())
      const fromDate = dayKey(new Date(Date.now() - (span - 1) * 86_400_000))
      const sessions = listSince(fromDate)
      const goal = readPrefs().dailyGoal
      return {
        range,
        fromDate,
        toDate,
        goal,
        stats: rangeStats(sessions, fromDate, toDate, goal),
        byTask: rangeByTask(sessions, fromDate, toDate),
        byHour: byHour(sessions, fromDate, toDate),
        byWeekday: byWeekday(sessions, fromDate, toDate),
        daily: dailySeries(sessions, fromDate, span, goal)
      }
    },

    /** 最近 days 天每天的专注分钟数与轮数，用于统计图。 */
    history: (days: number) => {
      const span = Math.max(1, Math.min(365, Math.round(days)))
      const from = new Date(Date.now() - (span - 1) * 86_400_000)
      const sessions = listSince(dayKey(from))
      const goal = readPrefs().dailyGoal
      const out: { date: string; rounds: number; focusMinutes: number; hitGoal: boolean }[] = []
      for (let i = span - 1; i >= 0; i--) {
        const date = dayKey(new Date(Date.now() - i * 86_400_000))
        const s = dayStats(sessions, date, goal)
        out.push({ date, rounds: s.rounds, focusMinutes: s.focusMinutes, hitGoal: s.goalProgress >= 1 })
      }
      return out
    }
  },

  // 桌宠 / 悬浮助手 / 快捷提问里说「定个 25 分钟番茄钟」走到这里。
  // 参数来自模型输出，一律当不可信输入夹范围。
  assistantActions: {
    'start-focus': (args) => {
      const prefs = readPrefs()
      const raw = Number(args.minutes)
      const minutes = Number.isFinite(raw) ? Math.max(1, Math.min(180, Math.round(raw))) : prefs.focusMin
      const task = typeof args.task === 'string' ? args.task.trim().slice(0, 60) : ''
      const running = getDb()
        .prepare('SELECT id FROM p_pomodoro_session WHERE end_at IS NULL LIMIT 1')
        .get() as { id: string } | undefined
      if (running) return { ok: false, message: '已经有一轮在跑了，先停掉或等它走完' }

      startSession('focus', minutes, null, null, task || null)
      return { ok: true, message: task ? `开始专注 ${minutes} 分钟：${task}` : `开始专注 ${minutes} 分钟` }
    },

    'pause-focus': () => {
      const row = getDb()
        .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL AND paused_at IS NULL LIMIT 1')
        .get() as SessionRow | undefined
      if (!row) return { ok: false, message: '现在没有在跑的专注' }
      getDb().prepare('UPDATE p_pomodoro_session SET paused_at = ? WHERE id = ?').run(localNowSec(), row.id)
      clearRoundTimer()
      return { ok: true, message: '已暂停，随时说继续' }
    },

    'resume-focus': () => {
      const row = getDb()
        .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL AND paused_at IS NOT NULL LIMIT 1')
        .get() as SessionRow | undefined
      if (!row) return { ok: false, message: '没有暂停中的专注' }
      const s = toSession(row)
      getDb()
        .prepare('UPDATE p_pomodoro_session SET paused_ms = ?, paused_at = NULL WHERE id = ?')
        .run(pausedMsAfterResume(s, Date.now()), row.id)
      scheduleRoundEnd()
      return { ok: true, message: '继续计时' }
    },

    'stop-focus': () => {
      const row = getDb()
        .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL LIMIT 1')
        .get() as SessionRow | undefined
      if (!row) return { ok: false, message: '现在没有在跑的专注' }
      const s = toSession(row)
      finishRound(s, false, Date.now())
      return { ok: true, message: '已停下这一轮' }
    }
  },

  counters: (): AchievementCounter[] => {
    const db = getDb()
    const done = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS m FROM p_pomodoro_session WHERE kind = 'focus' AND completed = 1")
      .get() as { n: number; m: number } | undefined
    const bestDay = db
      .prepare(
        `SELECT COUNT(*) AS n FROM p_pomodoro_session
         WHERE kind = 'focus' AND completed = 1
         GROUP BY substr(start_at, 1, 10)
         ORDER BY n DESC LIMIT 1`
      )
      .get() as { n: number } | undefined
    return [
      { key: 'pomodoro_rounds', value: done?.n ?? 0 },
      { key: 'pomodoro_focus_minutes', value: done?.m ?? 0 },
      { key: 'pomodoro_best_day', value: bestDay?.n ?? 0 }
    ]
  }
}

export default pomodoro
