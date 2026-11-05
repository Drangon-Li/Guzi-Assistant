// 前台应用时长、切换与分类覆盖（只存应用名与时刻）。
//
// 90 天内的时长和切换都直接从 activity_intervals 现算；app_usage 是按天累计的长期汇总，
// 只在时间线过了保留期之后才被读取。
import { getDb } from './connection.ts'
import { dayKey } from '@shared/work-report'
import type { AppCategoryOverride, AppSwitchRecord, AppUsageEntry } from '@shared/types'
import { activityUsage } from '../../shared/activity-timeline.ts'
import { listActivityIntervals } from './activity-timeline.ts'

// ---------- app_usage（前台应用使用时长，按天累计；只存应用名与秒数，不存内容）----------

export function addAppUsage(day: string, app: string, seconds: number): void {
  getDb().prepare(
    'INSERT INTO app_usage (day, app, seconds) VALUES (?, ?, ?) ON CONFLICT(day, app) DO UPDATE SET seconds = seconds + excluded.seconds'
  ).run(day, app, seconds)
}

/** 某天各应用使用时长，按时长降序。 */
export function appUsageSummary(day: string): AppUsageEntry[] {
  if (withinIntervalRetention(day)) {
    const fromMs = new Date(`${day}T00:00:00`).getTime()
    const d = new Date(fromMs)
    const toMs = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    return activityUsage(listActivityIntervals(fromMs, toMs), fromMs, toMs)
  }
  return getDb()
    .prepare('SELECT app, seconds FROM app_usage WHERE day = ? ORDER BY seconds DESC')
    .all(day) as AppUsageEntry[]
}

/** 日期范围内的应用时长（分析页近 7 天趋势用）。 */
export function appUsageRange(fromDay: string, toDay: string): (AppUsageEntry & { day: string })[] {
  const legacy = getDb().prepare('SELECT day, app, seconds FROM app_usage WHERE day >= ? AND day <= ? ORDER BY day')
    .all(fromDay, toDay) as (AppUsageEntry & { day: string })[]
  const result = legacy.filter((row) => !withinIntervalRetention(row.day))
  const fromMs = new Date(`${fromDay}T00:00:00`).getTime()
  const end = new Date(`${toDay}T00:00:00`)
  const toMs = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime()
  const byDay = new Map<string, ReturnType<typeof listActivityIntervals>>()
  for (const interval of listActivityIntervals(fromMs, toMs)) {
    const day = dayKey(new Date(interval.startMs))
    if (!withinIntervalRetention(day)) continue
    const items = byDay.get(day) ?? []
    items.push(interval)
    byDay.set(day, items)
  }
  for (const [day, intervals] of byDay) result.push(...activityUsage(intervals, fromMs, toMs).map((entry) => ({ ...entry, day })))
  return result.sort((a, b) => a.day.localeCompare(b.day))
}

// ---------- 应用切换（注意力分析素材）：由时间线里相邻的活跃区间推出 ----------

export function listAppSwitchesSince(sinceDay: string): AppSwitchRecord[] {
  const result: AppSwitchRecord[] = []
  const intervals = listActivityIntervals(new Date(`${sinceDay.slice(0, 10)}T00:00:00`).getTime(), Date.now() + 1)
  let previous: typeof intervals[number] | null = null
  for (const interval of intervals) {
    if (interval.state !== 'active' || !interval.appName) continue
    result.push({ ts: localTimestamp(interval.startMs), endTs: localTimestamp(interval.endMs),
      activeMs: interval.endMs - interval.startMs,
      fromApp: previous?.endMs === interval.startMs && previous.sessionId === interval.sessionId ? previous.appName : null,
      toApp: interval.appName })
    previous = interval
  }
  return result
}

// ---------- app_categories（应用生产力分类的用户覆盖；默认规则在 shared/attention.ts）----------

export function listAppCategoryOverrides(): AppCategoryOverride[] {
  return getDb().prepare('SELECT app, category FROM app_categories').all() as AppCategoryOverride[]
}

/** category 传 null 表示清除覆盖、回到默认规则。 */
export function setAppCategoryOverride(app: string, category: string | null): void {
  if (category === null) getDb().prepare('DELETE FROM app_categories WHERE app = ?').run(app)
  else
    getDb().prepare(
      'INSERT INTO app_categories (app, category) VALUES (?, ?) ON CONFLICT(app) DO UPDATE SET category = excluded.category'
    ).run(app, category)
}

/** 历史出现过的全部前台 App 名（app_usage + work_records），用于拒绝「裸 App 名」任务。 */
export function listKnownAppNames(): string[] {
  const names = new Set<string>()
  for (const row of getDb().prepare('SELECT DISTINCT app FROM app_usage').all() as { app: string }[]) names.add(row.app)
  for (const row of getDb().prepare('SELECT DISTINCT app FROM work_records WHERE app IS NOT NULL').all() as { app: string }[])
    names.add(row.app)
  return [...names]
}

function localTimestamp(atMs: number): string {
  const d = new Date(atMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** 这一天的时间线还完整保留着（最早那天可能被保留期截掉一半，按汇总表算） */
function withinIntervalRetention(day: string): boolean {
  return day > dayKey(new Date(Date.now() - 90 * 86_400_000))
}
