// 专注插件（主进程）：番茄钟会话的落库与统计。
//
// 计时不在主进程跑——渲染层按 wall clock 算剩余，主进程只在开始 / 暂停 / 恢复 / 结束时各写一次。
// 这样休眠、关窗、重启都不会让计时器和数据库对不上：没写 end_at 的会话就是没走完的，
// pausedAt 非空就是停在那儿的。
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { readPluginSetting, writePluginSetting } from '../../db/plugins.ts'
import { applyExternalPetSay } from '../../pet/controller'
import { localNowSec } from '@shared/parsing'
import { dayKey } from '@shared/work-report'
import {
  DEFAULT_PREFS,
  breakdownByTask,
  dayStats,
  normalizePrefs,
  pausedMsAfterResume,
  type PomodoroKind,
  type PomodoroPrefs,
  type PomodoroSession
} from '@shared/pomodoro'
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
    note: r.note
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
}

const pomodoro: PluginMainModule = {
  id: 'pomodoro',
  initTables,

  handlers: {
    prefs: () => readPrefs(),

    'prefs-save': (patch: Partial<PomodoroPrefs>) => {
      const next = normalizePrefs({ ...readPrefs(), ...patch })
      writePluginSetting('pomodoro', 'prefs', JSON.stringify(next))
      return next
    },

    start: (
      kind: PomodoroKind,
      minutes: number,
      blockId?: string | null,
      taskId?: string | null,
      taskTitle?: string | null
    ) => {
      const id = randomUUID()
      const startAt = localNowSec()
      getDb()
        .prepare(
          `INSERT INTO p_pomodoro_session
             (id, start_at, end_at, minutes, kind, completed, paused_ms, paused_at, block_id, task_id, task_title, note)
           VALUES (?, ?, NULL, ?, ?, 0, 0, NULL, ?, ?, ?, NULL)`
        )
        .run(
          id,
          startAt,
          Math.max(1, Math.round(minutes)),
          kind,
          blockId ?? null,
          taskId ?? null,
          taskTitle ?? null
        )
      return getSession(id)
    },

    pause: (id: string) => {
      const s = getSession(id)
      if (!s || s.pausedAt || s.endAt) return s
      getDb().prepare('UPDATE p_pomodoro_session SET paused_at = ? WHERE id = ?').run(localNowSec(), id)
      return getSession(id)
    },

    resume: (id: string) => {
      const s = getSession(id)
      if (!s || !s.pausedAt || s.endAt) return s
      getDb()
        .prepare('UPDATE p_pomodoro_session SET paused_ms = ?, paused_at = NULL WHERE id = ?')
        .run(pausedMsAfterResume(s, Date.now()), id)
      return getSession(id)
    },

    finish: (id: string, completed: boolean) => {
      const s = getSession(id)
      if (!s) return false
      // 中途放弃时把暂停时长结算掉，否则「实际投入」会把发呆的时间也算进去
      getDb()
        .prepare('UPDATE p_pomodoro_session SET end_at = ?, completed = ?, paused_ms = ?, paused_at = NULL WHERE id = ?')
        .run(localNowSec(), completed ? 1 : 0, pausedMsAfterResume(s, Date.now()), id)
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
        out.push({ date, rounds: s.rounds, focusMinutes: s.focusMinutes, hitGoal: s.rounds >= goal })
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

      const id = randomUUID()
      getDb()
        .prepare(
          `INSERT INTO p_pomodoro_session
             (id, start_at, end_at, minutes, kind, completed, paused_ms, paused_at, block_id, task_id, task_title, note)
           VALUES (?, ?, NULL, ?, 'focus', 0, 0, NULL, NULL, NULL, ?, NULL)`
        )
        .run(id, localNowSec(), minutes, task || null)
      return { ok: true, message: task ? `开始专注 ${minutes} 分钟：${task}` : `开始专注 ${minutes} 分钟` }
    },

    'pause-focus': () => {
      const row = getDb()
        .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL AND paused_at IS NULL LIMIT 1')
        .get() as SessionRow | undefined
      if (!row) return { ok: false, message: '现在没有在跑的专注' }
      getDb().prepare('UPDATE p_pomodoro_session SET paused_at = ? WHERE id = ?').run(localNowSec(), row.id)
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
      return { ok: true, message: '继续计时' }
    },

    'stop-focus': () => {
      const row = getDb()
        .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL LIMIT 1')
        .get() as SessionRow | undefined
      if (!row) return { ok: false, message: '现在没有在跑的专注' }
      const s = toSession(row)
      getDb()
        .prepare('UPDATE p_pomodoro_session SET end_at = ?, completed = 0, paused_ms = ?, paused_at = NULL WHERE id = ?')
        .run(localNowSec(), pausedMsAfterResume(s, Date.now()), row.id)
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
