// 成就计数器的汇总：核心自己的四个，加上每个已启用插件供给的。
//
// 与 ./index.ts 互相引用（index 要注册 achievement 模块，achievement 的 handler 要调这里，
// 这里又要读 index 的模块表）。这个环在 ESM 下是安全的——两边都没有依赖对方的顶层副作用，
// 这里只在函数体里访问 PLUGIN_MODULES。与 db/connection.ts ↔ db/detections.ts 同一个模式。
import { getDb } from '../db/connection.ts'
import { readEnabledPlugins } from '../db/plugins.ts'
import { dayKey } from '@shared/work-report'
import { streakOf } from '@shared/habit'
import type { CounterMap } from '@shared/achievement'
import { PLUGIN_MODULES } from './index.ts'
import type { AchievementCounter } from './types.ts'

/**
 * 核心成就的计数口径。这里刻意只读 tasks 和 reports 两张表：
 * 「用过多少天」用「捕获过内容的天数」来代表，比开一张新的使用日志表诚实，
 * 也不会因为只是打开窗口看了一眼就涨。
 */
export function coreCounters(): AchievementCounter[] {
  const db = getDb()
  const num = (sql: string): number =>
    ((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0)

  const dayRows = db
    .prepare('SELECT DISTINCT substr(created_at, 1, 10) AS d FROM tasks WHERE created_at IS NOT NULL')
    .all() as { d: string }[]
  const days = new Set(dayRows.map((r) => r.d).filter(Boolean))

  return [
    {
      key: 'core_tasks_confirmed',
      value: num("SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('pending', 'ignored')")
    },
    { key: 'core_reports', value: num('SELECT COUNT(*) AS n FROM reports') },
    { key: 'core_active_days', value: days.size },
    // 核心的「连续记录」就是最朴素的每日连续，借用打卡插件的口径（今天没记不算断）
    {
      key: 'core_active_streak',
      value: streakOf({ done: days, skipped: new Set() }, { kind: 'daily' }, dayKey(new Date()))
    }
  ]
}

/**
 * 核心 + 已启用插件的全部计数器。没启用的插件不供给，成就墙上对应条目会灰显——
 * 这正是「插件扩展插件」的落点：装得越多，成就越多。
 */
export function collectCounters(enabled: readonly string[] = readEnabledPlugins()): CounterMap {
  const out: Record<string, number> = {}
  for (const c of coreCounters()) out[c.key] = c.value
  for (const id of enabled) {
    const mod = PLUGIN_MODULES[id]
    if (!mod?.counters) continue
    for (const c of mod.counters()) out[c.key] = c.value
  }
  return out
}
