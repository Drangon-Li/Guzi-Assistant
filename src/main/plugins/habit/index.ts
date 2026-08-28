// 打卡插件（主进程）：习惯定义与每日打卡。
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { localNowSec } from '@shared/parsing'
import { dayKey } from '@shared/work-report'
import { bestStreakOf, buildHabitViews, type Habit, type HabitCheck } from '@shared/habit'
import type { AchievementCounter, PluginMainModule } from '../types.ts'

interface HabitRow {
  id: string
  name: string
  archived_at: string | null
  created_at: string
}

function listHabits(includeArchived = false): Habit[] {
  const sql = includeArchived
    ? 'SELECT * FROM p_habit_habit ORDER BY created_at'
    : 'SELECT * FROM p_habit_habit WHERE archived_at IS NULL ORDER BY created_at'
  return (getDb().prepare(sql).all() as HabitRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    archivedAt: r.archived_at,
    createdAt: r.created_at
  }))
}

function listChecks(): HabitCheck[] {
  return (
    getDb().prepare('SELECT habit_id, date FROM p_habit_check').all() as {
      habit_id: string
      date: string
    }[]
  ).map((r) => ({ habitId: r.habit_id, date: r.date }))
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
}

const habit: PluginMainModule = {
  id: 'habit',
  initTables,

  handlers: {
    list: () => {
      const today = dayKey(new Date())
      return { habits: buildHabitViews(listHabits(), listChecks(), today), today }
    },

    create: (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return { ok: false, error: '名字不能为空' }
      const dup = getDb()
        .prepare('SELECT id FROM p_habit_habit WHERE name = ? AND archived_at IS NULL')
        .get(trimmed)
      if (dup) return { ok: false, error: '已经有同名的习惯了' }
      const id = randomUUID()
      getDb()
        .prepare('INSERT INTO p_habit_habit (id, name, archived_at, created_at) VALUES (?, ?, NULL, ?)')
        .run(id, trimmed, localNowSec())
      return { ok: true, id }
    },

    rename: (id: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return false
      getDb().prepare('UPDATE p_habit_habit SET name = ? WHERE id = ?').run(trimmed, id)
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

    check: (habitId: string, date?: string) => {
      const day = date || dayKey(new Date())
      // 唯一索引保证一天一次；重复点击当成幂等而不是报错
      getDb()
        .prepare(
          'INSERT OR IGNORE INTO p_habit_check (id, habit_id, date, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(randomUUID(), habitId, day, localNowSec())
      return true
    },

    uncheck: (habitId: string, date?: string) => {
      const day = date || dayKey(new Date())
      getDb().prepare('DELETE FROM p_habit_check WHERE habit_id = ? AND date = ?').run(habitId, day)
      return true
    },

    archived: () => listHabits(true).filter((h) => h.archivedAt)
  },

  counters: (): AchievementCounter[] => {
    const db = getDb()
    const total =
      ((db.prepare('SELECT COUNT(*) AS n FROM p_habit_check').get() as { n: number } | undefined)?.n ?? 0)
    const byHabit = new Map<string, Set<string>>()
    for (const c of listChecks()) {
      let set = byHabit.get(c.habitId)
      if (!set) byHabit.set(c.habitId, (set = new Set()))
      set.add(c.date)
    }
    let best = 0
    for (const dates of byHabit.values()) best = Math.max(best, bestStreakOf(dates))
    return [
      { key: 'habit_checks', value: total },
      { key: 'habit_best_streak', value: best }
    ]
  }
}

export default habit
