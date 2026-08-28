// 打卡插件（主进程）：习惯定义、频率与每日打卡（含跳过与备注）。
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { localNowSec } from '@shared/parsing'
import { dayKey } from '@shared/work-report'
import {
  bestStreakOf,
  buildHabitViews,
  normalizeFrequency,
  type Habit,
  type HabitCheck,
  type HabitFrequency
} from '@shared/habit'
import type { AchievementCounter, AssistantActionResult, PluginMainModule } from '../types.ts'

interface HabitRow {
  id: string
  name: string
  frequency: string | null
  sort_order: number | null
  archived_at: string | null
  created_at: string
}

interface CheckRow {
  habit_id: string
  date: string
  skipped: number | null
  note: string | null
}

function parseFrequency(raw: string | null): HabitFrequency {
  if (!raw) return { kind: 'daily' }
  try {
    return normalizeFrequency(JSON.parse(raw))
  } catch {
    return { kind: 'daily' }
  }
}

function listHabits(includeArchived = false): Habit[] {
  const sql = includeArchived
    ? 'SELECT * FROM p_habit_habit ORDER BY sort_order, created_at'
    : 'SELECT * FROM p_habit_habit WHERE archived_at IS NULL ORDER BY sort_order, created_at'
  return (getDb().prepare(sql).all() as HabitRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    frequency: parseFrequency(r.frequency),
    archivedAt: r.archived_at,
    createdAt: r.created_at
  }))
}

function listChecks(): HabitCheck[] {
  return (
    getDb().prepare('SELECT habit_id, date, skipped, note FROM p_habit_check').all() as CheckRow[]
  ).map((r) => ({
    habitId: r.habit_id,
    date: r.date,
    skipped: !!r.skipped,
    note: r.note
  }))
}

/** 写一条打卡（或跳过）。一天一次由唯一索引保证，重复调用视作更新。 */
function upsertCheck(habitId: string, date: string, skipped: boolean, note: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO p_habit_check (id, habit_id, date, skipped, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(habit_id, date) DO UPDATE SET skipped = excluded.skipped, note = excluded.note`
    )
    .run(randomUUID(), habitId, date, skipped ? 1 : 0, note, localNowSec())
}

const initTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p_habit_habit (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS p_habit_check (
      id TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_p_habit_check_once ON p_habit_check(habit_id, date);
    CREATE INDEX IF NOT EXISTS idx_p_habit_check_date ON p_habit_check(date);
  `)
  // 增量迁移：频率、排序、跳过与备注是后加的，只加列，旧行取默认值（每天 / 未跳过 / 无备注）。
  const hCols = (db.prepare('PRAGMA table_info(p_habit_habit)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!hCols.includes('frequency')) db.exec('ALTER TABLE p_habit_habit ADD COLUMN frequency TEXT')
  if (!hCols.includes('sort_order'))
    db.exec('ALTER TABLE p_habit_habit ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')

  const cCols = (db.prepare('PRAGMA table_info(p_habit_check)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!cCols.includes('skipped'))
    db.exec('ALTER TABLE p_habit_check ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0')
  if (!cCols.includes('note')) db.exec('ALTER TABLE p_habit_check ADD COLUMN note TEXT')
}

/** 助手动作共用：按名字找唯一一个习惯，然后打卡或跳过。 */
function runCheck(args: Record<string, unknown>, skipped: boolean): AssistantActionResult {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return { ok: false, message: '没说是哪个习惯' }
  const all = listHabits()
  if (!all.length) return { ok: false, message: '还没有建过习惯' }

  const exact = all.filter((h) => h.name === name)
  const fuzzy = all.filter((h) => h.name.includes(name) || name.includes(h.name))
  const hits = exact.length ? exact : fuzzy
  if (!hits.length) return { ok: false, message: `没找到叫「${name}」的习惯` }
  if (hits.length > 1)
    return { ok: false, message: `有好几个像「${name}」的：${hits.map((h) => h.name).join('、')}` }

  const target = hits[0]
  upsertCheck(target.id, dayKey(new Date()), skipped, null)
  return {
    ok: true,
    message: skipped ? `「${target.name}」今天记为跳过，连续不断` : `「${target.name}」打卡了`
  }
}

const habit: PluginMainModule = {
  id: 'habit',
  initTables,

  handlers: {
    list: (windowDays?: number) => {
      const today = dayKey(new Date())
      return {
        habits: buildHabitViews(listHabits(), listChecks(), today, Math.max(7, Math.min(120, Math.round(windowDays ?? 28)))),
        today
      }
    },

    create: (name: string, frequency?: unknown) => {
      const trimmed = String(name ?? '').trim()
      if (!trimmed) return { ok: false, error: '名字不能为空' }
      const db = getDb()
      const dup = db
        .prepare('SELECT id FROM p_habit_habit WHERE name = ? AND archived_at IS NULL')
        .get(trimmed)
      if (dup) return { ok: false, error: '已经有同名的习惯了' }
      const next = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM p_habit_habit').get() as
        | { n: number }
        | undefined)?.n ?? 0
      const id = randomUUID()
      db.prepare(
        `INSERT INTO p_habit_habit (id, name, frequency, sort_order, archived_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`
      ).run(id, trimmed, JSON.stringify(normalizeFrequency(frequency)), next + 1, localNowSec())
      return { ok: true, id }
    },

    update: (id: string, patch: { name?: string; frequency?: unknown }) => {
      const db = getDb()
      if (patch.name !== undefined) {
        const trimmed = String(patch.name).trim()
        if (trimmed) db.prepare('UPDATE p_habit_habit SET name = ? WHERE id = ?').run(trimmed, id)
      }
      if (patch.frequency !== undefined) {
        db.prepare('UPDATE p_habit_habit SET frequency = ? WHERE id = ?').run(
          JSON.stringify(normalizeFrequency(patch.frequency)),
          id
        )
      }
      return true
    },

    /** 上移/下移：只和相邻一项交换 sort_order。 */
    reorder: (id: string, delta: number) => {
      const habits = listHabits()
      const i = habits.findIndex((h) => h.id === id)
      const j = i + (delta < 0 ? -1 : 1)
      if (i < 0 || j < 0 || j >= habits.length) return false
      const db = getDb()
      const stmt = db.prepare('UPDATE p_habit_habit SET sort_order = ? WHERE id = ?')
      db.transaction(() => {
        stmt.run(j + 1, habits[i].id)
        stmt.run(i + 1, habits[j].id)
      })()
      return true
    },

    // 归档而不是删除：习惯从列表消失，但历史打卡留着，累计次数和成就不会因为
    // 「不想做这个习惯了」而倒退。
    archive: (id: string) => {
      getDb().prepare('UPDATE p_habit_habit SET archived_at = ? WHERE id = ?').run(localNowSec(), id)
      return true
    },

    unarchive: (id: string) => {
      getDb().prepare('UPDATE p_habit_habit SET archived_at = NULL WHERE id = ?').run(id)
      return true
    },

    /** 彻底删除一个已归档的习惯及其打卡记录。 */
    destroy: (id: string) => {
      const db = getDb()
      db.transaction(() => {
        db.prepare('DELETE FROM p_habit_check WHERE habit_id = ?').run(id)
        db.prepare('DELETE FROM p_habit_habit WHERE id = ?').run(id)
      })()
      return true
    },

    check: (habitId: string, date?: string, note?: string) => {
      upsertCheck(habitId, date || dayKey(new Date()), false, String(note ?? '').slice(0, 200) || null)
      return true
    },

    /** 主动跳过：不算完成，但连续不断。 */
    skip: (habitId: string, date?: string, note?: string) => {
      upsertCheck(habitId, date || dayKey(new Date()), true, String(note ?? '').slice(0, 200) || null)
      return true
    },

    uncheck: (habitId: string, date?: string) => {
      getDb()
        .prepare('DELETE FROM p_habit_check WHERE habit_id = ? AND date = ?')
        .run(habitId, date || dayKey(new Date()))
      return true
    },

    /** 某个习惯的全部打卡记录，用于详情里的备注回看。 */
    history: (habitId: string) =>
      (
        getDb()
          .prepare(
            'SELECT habit_id, date, skipped, note FROM p_habit_check WHERE habit_id = ? ORDER BY date DESC LIMIT 120'
          )
          .all(habitId) as CheckRow[]
      ).map((r) => ({ habitId: r.habit_id, date: r.date, skipped: !!r.skipped, note: r.note })),

    archived: () => listHabits(true).filter((h) => h.archivedAt)
  },

  // 「今天的步数打卡」走到这里。名字用模糊匹配，但匹配到多个就明确失败——
  // 宁可让用户再说一遍，也不要替他打错卡。
  assistantActions: {
    check: (args) => runCheck(args, false),
    skip: (args) => runCheck(args, true)
  },

  counters: (): AchievementCounter[] => {
    const db = getDb()
    const total =
      ((db.prepare('SELECT COUNT(*) AS n FROM p_habit_check WHERE skipped = 0').get() as
        | { n: number }
        | undefined)?.n ?? 0)

    const habits = listHabits()
    const checks = listChecks()
    const byHabit = new Map<string, { done: Set<string>; skipped: Set<string> }>()
    for (const c of checks) {
      let m = byHabit.get(c.habitId)
      if (!m) byHabit.set(c.habitId, (m = { done: new Set(), skipped: new Set() }))
      ;(c.skipped ? m.skipped : m.done).add(c.date)
    }
    let best = 0
    for (const h of habits) {
      const marks = byHabit.get(h.id)
      if (marks) best = Math.max(best, bestStreakOf(marks, h.frequency))
    }
    return [
      { key: 'habit_checks', value: total },
      { key: 'habit_best_streak', value: best }
    ]
  }
}

export default habit
