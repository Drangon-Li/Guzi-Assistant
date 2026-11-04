// activity_intervals：统一活动时间线（应用时长、切换、工作记录都从这里派生），保留 90 天。
import { getDb } from './connection.ts'
import type { ActivityInterval } from '../../shared/activity-timeline.ts'

const INTERVAL_RETENTION_MS = 90 * 86_400_000

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

let lastPruneMs = 0

export function persistActivityIntervals(intervals: ActivityInterval[], nowMs = Date.now()): void {
  if (!intervals.length) return
  const insert = getDb().prepare(`INSERT INTO activity_intervals
    (id, session_id, start_ms, end_ms, state, app_name, bundle_id, history_allowed, end_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET end_ms = MAX(end_ms, excluded.end_ms), end_reason = excluded.end_reason`)
  getDb().transaction(() => {
    for (const i of intervals) insert.run(i.id, i.sessionId, i.startMs, i.endMs, i.state,
      i.appName, i.bundleId, i.historyAllowed ? 1 : 0, i.endReason)
    if (nowMs - lastPruneMs > 3_600_000) {
      getDb().prepare('DELETE FROM activity_intervals WHERE end_ms < ?').run(nowMs - INTERVAL_RETENTION_MS)
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
