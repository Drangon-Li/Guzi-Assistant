// 成就插件（主进程）：把各处的计数器算成解锁状态，并记下第一次达成的时刻。
//
// 解锁时刻只写一次。之所以要落库而不是每次现算，是为了「新解锁」这件事只发生一次——
// 否则每次打开成就页都会重放一遍庆祝动画。
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { readEnabledPlugins } from '../../db/plugins.ts'
import { localNowSec } from '@shared/parsing'
import {
  computeAchievements,
  newlyUnlocked,
  summarize,
  type UnlockMap
} from '@shared/achievement'
import { collectCounters } from '../counters.ts'
import type { PluginMainModule } from '../types.ts'

function readUnlocks(): UnlockMap {
  const rows = getDb().prepare('SELECT key, unlocked_at FROM p_achievement_unlock').all() as {
    key: string
    unlocked_at: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.unlocked_at]))
}

const initTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p_achievement_unlock (
      key TEXT PRIMARY KEY,
      unlocked_at TEXT NOT NULL
    );
  `)
}

const achievement: PluginMainModule = {
  id: 'achievement',
  initTables,

  handlers: {
    list: () => {
      const enabled = readEnabledPlugins()
      const counters = collectCounters(enabled)
      const before = readUnlocks()
      const fresh = newlyUnlocked(computeAchievements(counters, before, enabled))

      if (fresh.length) {
        const at = localNowSec()
        const stmt = getDb().prepare(
          'INSERT OR IGNORE INTO p_achievement_unlock (key, unlocked_at) VALUES (?, ?)'
        )
        getDb().transaction(() => {
          for (const key of fresh) stmt.run(key, at)
        })()
      }

      const views = computeAchievements(counters, readUnlocks(), enabled)
      return { views, summary: summarize(views), newly: fresh }
    }
  }
}

export default achievement
