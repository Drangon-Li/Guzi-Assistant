import { getDb } from './connection.ts'
import { getSettings } from './settings.ts'
import { dayKey } from '../../shared/work-report.ts'
import { ACTIVITY_MAX_HEARTBEAT_GAP_MS, timelineDayEnabled, type ActivityInterval } from '../../shared/activity-timeline.ts'

interface IntervalRow {
  id: string
  session_id: string
  start_ms: number
  end_ms: number
  state: ActivityInterval['state']
  app_name: string | null
  bundle_id: string | null
  history_allowed: number
  end_reason: string
}

interface UsageComparisonBaseline { fromMs: number; legacySeconds: number }
const COMPARISON_KEY_PREFIX = 'activityTimelineComparison:'

function comparisonBaseline(day: string): UsageComparisonBaseline | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(COMPARISON_KEY_PREFIX + day) as { value: string } | undefined
  if (!row) return null
  try {
    const value = JSON.parse(row.value) as UsageComparisonBaseline
    return Number.isFinite(value.fromMs) && Number.isFinite(value.legacySeconds) && value.legacySeconds >= 0 ? value : null
  } catch { return null }
}

function legacyUsageSeconds(day: string): number {
  return (getDb().prepare('SELECT COALESCE(SUM(seconds), 0) AS seconds FROM app_usage WHERE day = ?').get(day) as { seconds: number }).seconds
}

function captureComparisonBaseline(intervals: ActivityInterval[]): void {
  const starts = new Map<string, number>()
  const previousEnd = getDb().prepare('SELECT end_ms FROM activity_intervals WHERE id = ?')
  for (const interval of intervals) {
    const day = dayKey(new Date(interval.startMs))
    const baseline = comparisonBaseline(day)
    if (baseline && legacyUsageSeconds(day) >= baseline.legacySeconds) continue
    const previous = previousEnd.get(interval.id) as { end_ms: number } | undefined
    // The legacy writer credits this heartbeat after persistence, so begin at its previous confirmed end.
    const fromMs = Math.min(interval.endMs, previous?.end_ms ?? interval.startMs)
    starts.set(day, Math.min(starts.get(day) ?? Infinity, fromMs))
  }
  const insert = getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [day, fromMs] of starts) insert.run(COMPARISON_KEY_PREFIX + day,
    JSON.stringify({ fromMs, legacySeconds: legacyUsageSeconds(day) }))
}

let lastPruneMs = 0

export function persistActivityIntervals(intervals: ActivityInterval[], nowMs = Date.now()): void {
  if (!intervals.length) return
  const insert = getDb().prepare(`INSERT INTO activity_intervals
    (id, session_id, start_ms, end_ms, state, app_name, bundle_id, history_allowed, end_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET end_ms = MAX(end_ms, excluded.end_ms), end_reason = excluded.end_reason`)
  getDb().transaction(() => {
    captureComparisonBaseline(intervals)
    for (const i of intervals) insert.run(i.id, i.sessionId, i.startMs, i.endMs, i.state,
      i.appName, i.bundleId, i.historyAllowed ? 1 : 0, i.endReason)
    if (nowMs - lastPruneMs > 3_600_000) {
      getDb().prepare('DELETE FROM activity_intervals WHERE end_ms < ?').run(nowMs - 90 * 86_400_000)
      getDb().prepare('DELETE FROM settings WHERE key GLOB ? AND key < ?').run(
        COMPARISON_KEY_PREFIX + '*', COMPARISON_KEY_PREFIX + dayKey(new Date(nowMs - 90 * 86_400_000)))
      lastPruneMs = nowMs
    }
  })()
}

export function listActivityIntervals(fromMs: number, toMs: number, options: { historyOnly?: boolean } = {}): ActivityInterval[] {
  const rows = getDb().prepare(`SELECT * FROM activity_intervals WHERE end_ms > ? AND start_ms < ?
    ${options.historyOnly ? "AND state = 'active' AND history_allowed = 1" : ''} ORDER BY start_ms, id`).all(fromMs, toMs) as IntervalRow[]
  return rows.map((r) => ({
    id: r.id, sessionId: r.session_id, startMs: r.start_ms, endMs: r.end_ms, state: r.state,
    appName: r.app_name, bundleId: r.bundle_id, historyAllowed: r.history_allowed === 1, endReason: r.end_reason
  }))
}

export function activityTimelineDaySelector(): (day: string) => boolean {
  const settings = getSettings()
  return (day) => timelineDayEnabled(settings.activityTimelineMode, settings.activityTimelineCutoverAt, day)
}

export function usesTimelineForDay(day: string): boolean {
  return activityTimelineDaySelector()(day)
}

/** Active evidence, not repeated OCR text, is the only authority for extending legacy observations. */
export function continuousActivityEvidence(fromMs: number, toMs: number, app: string): { intervalId: string; activeMs: number; confirmedEndMs: number } | null {
  if (toMs <= fromMs) return null
  const intervals = listActivityIntervals(fromMs, toMs)
  let cursor = fromMs
  let activeMs = 0
  for (const interval of intervals) {
    if (interval.state !== 'active' || !interval.historyAllowed || interval.appName !== app || interval.startMs > cursor) return null
    const end = Math.min(toMs, interval.endMs)
    if (end <= cursor) continue
    activeMs += end - cursor
    cursor = end
    if (cursor >= toMs) return { intervalId: intervals[0].id, activeMs, confirmedEndMs: cursor }
  }
  // Model responses arrive between heartbeats; keep the fresh confirmed prefix, never its unobserved tail.
  return activeMs > 0 && toMs - cursor <= ACTIVITY_MAX_HEARTBEAT_GAP_MS
    ? { intervalId: intervals[0].id, activeMs, confirmedEndMs: cursor } : null
}

/** Local shadow evidence: totals are compared without changing the selected UI source. */
export function compareActivityUsage(day: string): {
  comparable: boolean; comparisonFromMs: number | null;
  comparisonReason: 'baseline_missing' | 'legacy_baseline_reset' | null;
  legacySeconds: number; timelineSeconds: number; deltaSeconds: number;
  stateSeconds: Record<string, number>; endReasons: Record<string, number>; historyExcludedSeconds: number
} {
  const date = new Date(`${day}T00:00:00`)
  const baseline = comparisonBaseline(day)
  const legacySecondsNow = legacyUsageSeconds(day)
  if (!baseline || legacySecondsNow < baseline.legacySeconds) return {
    comparable: false, comparisonFromMs: baseline?.fromMs ?? null,
    comparisonReason: baseline ? 'legacy_baseline_reset' : 'baseline_missing',
    legacySeconds: 0, timelineSeconds: 0, deltaSeconds: 0, stateSeconds: {}, endReasons: {}, historyExcludedSeconds: 0
  }
  const fromMs = Math.max(date.getTime(), baseline.fromMs)
  const toMs = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  const intervals = listActivityIntervals(fromMs, toMs)
  const stateSeconds: Record<string, number> = {}
  const endReasons: Record<string, number> = {}
  let historyExcludedSeconds = 0
  for (const interval of intervals) {
    const seconds = Math.max(0, Math.min(interval.endMs, toMs) - Math.max(interval.startMs, fromMs)) / 1_000
    stateSeconds[interval.state] = (stateSeconds[interval.state] ?? 0) + seconds
    endReasons[interval.endReason] = (endReasons[interval.endReason] ?? 0) + 1
    if (interval.state === 'active' && !interval.historyAllowed) historyExcludedSeconds += seconds
  }
  const timelineSeconds = stateSeconds.active ?? 0
  const legacySeconds = legacySecondsNow - baseline.legacySeconds
  return { comparable: true, comparisonFromMs: fromMs, comparisonReason: null,
    legacySeconds, timelineSeconds, deltaSeconds: timelineSeconds - legacySeconds, stateSeconds, endReasons, historyExcludedSeconds }
}
