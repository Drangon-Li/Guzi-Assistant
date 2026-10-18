// app_usage / app_switches / app_categories：前台应用时长、切换事件与分类覆盖（只存应用名与时刻）。
import { getDb } from './connection.ts'
import { localNowSec } from '@shared/parsing'
import { dayKey } from '@shared/work-report'
import type { AppCategoryOverride, AppSwitchRecord, AppUsageEntry } from '@shared/types'
import { activityUsage } from '../../shared/activity-timeline.ts'
import { listActivityIntervals, usesTimelineForDay } from './activity-timeline.ts'

// ---------- app_usage（前台应用使用时长，按天累计；只存应用名与秒数，不存内容）----------

export function addAppUsage(day: string, app: string, seconds: number): void {
  getDb().prepare(
    'INSERT INTO app_usage (day, app, seconds) VALUES (?, ?, ?) ON CONFLICT(day, app) DO UPDATE SET seconds = seconds + excluded.seconds'
  ).run(day, app, seconds)
}

/** 某天各应用使用时长，按时长降序。 */
export function appUsageSummary(day: string): AppUsageEntry[] {
  if (usesTimelineUsageForDay(day)) {
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
  const result = legacy.filter((row) => !usesTimelineUsageForDay(row.day))
  const fromMs = new Date(`${fromDay}T00:00:00`).getTime()
  const end = new Date(`${toDay}T00:00:00`)
  const toMs = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime()
  const byDay = new Map<string, ReturnType<typeof listActivityIntervals>>()
  for (const interval of listActivityIntervals(fromMs, toMs)) {
    const day = dayKey(new Date(interval.startMs))
    if (!usesTimelineUsageForDay(day)) continue
    const items = byDay.get(day) ?? []
    items.push(interval)
    byDay.set(day, items)
  }
  for (const [day, intervals] of byDay) result.push(...activityUsage(intervals, fromMs, toMs).map((entry) => ({ ...entry, day })))
  return result.sort((a, b) => a.day.localeCompare(b.day))
}

// ---------- app_switches（前台应用切换事件；只存应用名与时刻，不存内容。注意力分析素材）----------

export function addAppSwitch(fromApp: string | null, toApp: string, atMs?: number): void {
  // 秒级时间戳：同一分钟内多次切换需稳定排序，短停留判定也依赖亚分钟精度
  getDb().prepare('INSERT INTO app_switches (ts, from_app, to_app) VALUES (?, ?, ?)').run(
    atMs == null ? localNowSec() : localTimestamp(atMs),
    fromApp,
    toApp
  )
}

export function listAppSwitchesSince(sinceDay: string): AppSwitchRecord[] {
  const legacy = getDb().prepare(
    'SELECT ts, from_app AS fromApp, to_app AS toApp FROM app_switches WHERE ts >= ? ORDER BY ts'
  ).all(sinceDay) as AppSwitchRecord[]
  const result = legacy.filter((item) => !usesTimelineForDay(item.ts.slice(0, 10)))
  const intervals = listActivityIntervals(new Date(`${sinceDay.slice(0, 10)}T00:00:00`).getTime(), Date.now() + 1)
  let previous: typeof intervals[number] | null = null
  for (const interval of intervals) {
    if (interval.state !== 'active' || !interval.appName || !usesTimelineForDay(dayKey(new Date(interval.startMs)))) continue
    result.push({ ts: localTimestamp(interval.startMs), endTs: localTimestamp(interval.endMs),
      activeMs: interval.endMs - interval.startMs,
      fromApp: previous?.endMs === interval.startMs && previous.sessionId === interval.sessionId ? previous.appName : null,
      toApp: interval.appName })
    previous = interval
  }
  return result.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
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

function usesTimelineUsageForDay(day: string): boolean {
  const oldestPartialDay = dayKey(new Date(Date.now() - 90 * 86_400_000))
  return day > oldestPartialDay && usesTimelineForDay(day)
}
