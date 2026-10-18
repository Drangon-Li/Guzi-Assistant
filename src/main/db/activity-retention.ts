import { getDb } from './connection.ts'
import { listActivityIntervals } from './activity-timeline.ts'
import type { ActivityInterval } from '../../shared/activity-timeline.ts'

interface ProjectionRow {
  id: string; content: string; app: string | null; task: string | null; evidence_source: string;
  segment_id: string; start_at: string; end_at: string; confidence: number; evidence_count: number;
  summary_hash: string | null; derived_by: string; created_at: string; interval_id: string; active_ms: number | null
}

function localTimestamp(ms: number): string {
  const d = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${d.getMilliseconds() ? `.${String(d.getMilliseconds()).padStart(3, '0')}` : ''}`
}

/** Hide History's permission for the requested time; the separately consented application totals remain intact. */
export function deleteActivityHistoryRange(fromMs: number, toMs: number): string[] {
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) throw new RangeError('history delete range must satisfy from < to')
  const db = getDb()
  const deletedWorkIds: string[] = []
  db.transaction(() => {
    const intervals = listActivityIntervals(fromMs, toMs).filter((interval) => interval.historyAllowed)
    const insertInterval = db.prepare(`INSERT INTO activity_intervals
      (id,session_id,start_ms,end_ms,state,app_name,bundle_id,history_allowed,end_reason) VALUES (?,?,?,?,?,?,?,?,?)`)
    const insertProjection = db.prepare(`INSERT INTO work_records
      (id,content,app,task,evidence_source,segment_id,start_at,end_at,confidence,evidence_count,summary_hash,derived_by,created_at,interval_id,active_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const interval of intervals) {
      const hiddenStart = Math.max(fromMs, interval.startMs)
      const hiddenEnd = Math.min(toMs, interval.endMs)
      const pieces: ActivityInterval[] = []
      const append = (startMs: number, endMs: number, historyAllowed: boolean): void => {
        if (endMs <= startMs) return
        pieces.push({ ...interval, id: `${interval.id}:history-${startMs}-${endMs}-${historyAllowed ? 1 : 0}`,
          startMs, endMs, historyAllowed, endReason: historyAllowed ? interval.endReason : 'history-deleted' })
      }
      append(interval.startMs, hiddenStart, true)
      append(hiddenStart, hiddenEnd, false)
      append(hiddenEnd, interval.endMs, true)
      const projections = db.prepare("SELECT * FROM work_records WHERE derived_by = 'timeline' AND interval_id = ?")
        .all(interval.id) as ProjectionRow[]
      db.prepare("DELETE FROM work_records WHERE derived_by = 'timeline' AND interval_id = ?").run(interval.id)
      db.prepare('DELETE FROM activity_intervals WHERE id = ?').run(interval.id)
      for (const piece of pieces) insertInterval.run(piece.id, piece.sessionId, piece.startMs, piece.endMs,
        piece.state, piece.appName, piece.bundleId, piece.historyAllowed ? 1 : 0, piece.endReason)
      for (const projection of projections) {
        deletedWorkIds.push(projection.id)
        for (const piece of pieces.filter((part) => part.historyAllowed)) {
          const start = Math.max(Date.parse(projection.start_at), piece.startMs)
          const end = Math.min(Date.parse(projection.end_at), piece.endMs)
          if (end <= start) continue
          insertProjection.run(`timeline-work-${projection.segment_id}-${piece.id}`, projection.content, projection.app,
            projection.task, projection.evidence_source, projection.segment_id, localTimestamp(start), localTimestamp(end),
            projection.confidence, projection.evidence_count, projection.summary_hash, 'timeline', localTimestamp(end), piece.id,
            Math.min(projection.active_ms ?? end - start, end - start))
        }
      }
    }
    // Duration snapshots outlive the 90-day raw intervals and still obey explicit History deletion.
    const remaining = db.prepare("SELECT * FROM work_records WHERE derived_by = 'timeline'").all() as ProjectionRow[]
    for (const row of remaining) {
      const start = Date.parse(row.start_at)
      const end = Date.parse(row.end_at)
      if (!(end > fromMs && start < toMs) && !(start === end && start >= fromMs && start < toMs)) continue
      db.prepare('DELETE FROM work_records WHERE id = ?').run(row.id)
      deletedWorkIds.push(row.id)
      for (const [partStart, partEnd] of [[start, Math.min(end, fromMs)], [Math.max(start, toMs), end]]) {
        if (partEnd <= partStart) continue
        const intervalId = `${row.interval_id}:history-snapshot-${partStart}-${partEnd}`
        insertProjection.run(`timeline-work-${row.segment_id}-${intervalId}`, row.content, row.app, row.task,
          row.evidence_source, row.segment_id, localTimestamp(partStart), localTimestamp(partEnd), row.confidence,
          row.evidence_count, row.summary_hash, 'timeline', localTimestamp(partEnd), intervalId,
          Math.min(row.active_ms ?? partEnd - partStart, partEnd - partStart))
      }
    }
    // OCR timestamps are canonical UTC ISO, but parsing also preserves compatibility with prior local timestamps.
    const evidence = db.prepare('SELECT id, occurred_at FROM ocr_evidence').all() as { id: string; occurred_at: string }[]
    const removeEvidence = db.prepare('DELETE FROM ocr_evidence WHERE id = ?')
    for (const row of evidence) {
      const ms = Date.parse(row.occurred_at)
      if (ms >= fromMs && ms < toMs) removeEvidence.run(row.id)
    }
  })()
  return [...new Set(deletedWorkIds)]
}

export function clearActivityHistory(): string[] {
  const db = getDb()
  return db.transaction(() => {
    const rows = db.prepare("SELECT id FROM work_records WHERE derived_by = 'timeline'").all() as { id: string }[]
    db.prepare("UPDATE activity_intervals SET history_allowed = 0, end_reason = 'history-cleared' WHERE history_allowed = 1").run()
    db.prepare("DELETE FROM work_records WHERE derived_by = 'timeline'").run()
    db.prepare('DELETE FROM ocr_evidence').run()
    return rows.map((row) => row.id)
  })()
}
