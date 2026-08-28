// 专注插件（主进程）：番茄钟会话的落库与统计。
//
// 计时不在主进程跑——渲染层按 wall clock 算剩余，主进程只在开始和结束时各写一次。
// 这样休眠、关窗、重启都不会让计时器和数据库对不上：没写 end_at 的会话就是没走完的。
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { readPluginSetting, writePluginSetting } from '../../db/plugins.ts'
import { applyExternalPetSay } from '../../pet/controller'
import { localNowSec } from '@shared/parsing'
import { dayKey } from '@shared/work-report'
import {
  DEFAULT_PREFS,
  dayStats,
  normalizePrefs,
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
  block_id: string | null
  task_id: string | null
}

function toSession(r: SessionRow): PomodoroSession {
  return {
    id: r.id,
    startAt: r.start_at,
    endAt: r.end_at,
    minutes: r.minutes,
    kind: r.kind === 'break' ? 'break' : 'focus',
    completed: !!r.completed,
    blockId: r.block_id,
    taskId: r.task_id
  }
}

function listSince(fromDate: string): PomodoroSession[] {
  return (
    getDb()
      .prepare('SELECT * FROM p_pomodoro_session WHERE start_at >= ? ORDER BY start_at')
      .all(fromDate) as SessionRow[]
  ).map(toSession)
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

    start: (kind: PomodoroKind, minutes: number, blockId?: string | null, taskId?: string | null) => {
      const id = randomUUID()
      const startAt = localNowSec()
      getDb()
        .prepare(
          `INSERT INTO p_pomodoro_session (id, start_at, end_at, minutes, kind, completed, block_id, task_id)
           VALUES (?, ?, NULL, ?, ?, 0, ?, ?)`
        )
        .run(id, startAt, Math.max(1, Math.round(minutes)), kind, blockId ?? null, taskId ?? null)
      return { id, startAt }
    },

    finish: (id: string, completed: boolean) => {
      getDb()
        .prepare('UPDATE p_pomodoro_session SET end_at = ?, completed = ? WHERE id = ?')
        .run(localNowSec(), completed ? 1 : 0, id)
      return true
    },

    // 插件借用核心服务的例子：结束播报走桌宠气泡，而不是自己弹一个窗。
    // 用户把桌宠关了或调成安静，这里自然就不响——不需要插件自己再判一遍。
    say: (message: string) => {
      applyExternalPetSay(String(message).slice(0, 60))
      return true
    },

    /** 未写 end_at 的会话——重启后用来恢复「刚才那轮还在跑」。 */
    running: () => {
      const row = getDb()
        .prepare('SELECT * FROM p_pomodoro_session WHERE end_at IS NULL ORDER BY start_at DESC LIMIT 1')
        .get() as SessionRow | undefined
      return row ? toSession(row) : null
    },

    today: () => {
      const today = dayKey(new Date())
      const sessions = listSince(today)
      return { today, sessions, stats: dayStats(sessions, today) }
    },

    /** 最近 days 天每天的专注分钟数与轮数，用于统计图。 */
    history: (days: number) => {
      const span = Math.max(1, Math.min(365, Math.round(days)))
      const from = new Date(Date.now() - (span - 1) * 86_400_000)
      const sessions = listSince(dayKey(from))
      const out: { date: string; rounds: number; focusMinutes: number }[] = []
      for (let i = span - 1; i >= 0; i--) {
        const date = dayKey(new Date(Date.now() - i * 86_400_000))
        const s = dayStats(sessions, date)
        out.push({ date, rounds: s.rounds, focusMinutes: s.focusMinutes })
      }
      return out
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
