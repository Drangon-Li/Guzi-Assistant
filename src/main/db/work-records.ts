// work_records：工作记录。legacy OCR 路径与 History v2 摘要派生路径共用这张表，
// 靠 derived_by / segment_id / summary_hash 区分与幂等去重。
import { getDb } from './connection.ts'
import { localNow } from '@shared/parsing'
import type { HistoryDerivedWorkRecordInput, WorkRecord, WorkRecordSource } from '@shared/types'
import { normalizeTaskLabel } from '@shared/work-report'
import { randomUUID } from 'crypto'

// ---------- work_records（工作记录：屏幕识别顺带的「在做什么」时间线，供日报生成）----------

const WORK_RECORDS_CAP = 5000 // 只留最近 N 条，避免无界增长

interface WorkRecordRow {
  id: string
  content: string
  app: string | null
  task: string | null
  evidence_source?: string | null
  derived_by?: string | null
  segment_id?: string | null
  start_at?: string | null
  end_at?: string | null
  confidence?: number | null
  evidence_count?: number | null
  summary_hash?: string | null
  created_at: string
}

function rowToWorkRecord(r: WorkRecordRow): WorkRecord {
  const createdAt = r.created_at
  return {
    id: r.id,
    content: r.content,
    app: r.app,
    task: normalizeTaskLabel(r.task),
    source: r.evidence_source === 'accessibility' ? 'accessibility' : 'ocr',
    derivedBy: r.derived_by === 'history' ? 'history' : 'legacy',
    segmentId: r.segment_id ?? null,
    startAt: r.start_at ?? createdAt,
    endAt: r.end_at ?? createdAt,
    confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
    evidenceCount: Math.max(0, Math.trunc(Number(r.evidence_count) || 0)),
    summaryHash: r.summary_hash ?? null,
    createdAt
  }
}

function localDateTimeAtPrecise(value: string, fallback = localNow()): string {
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) return fallback
  const d = new Date(timestampMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function normalizeWorkTimestamp(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  // Existing callers use local YYYY-MM-DDTHH:mm values. History summaries use
  // UTC ISO values, which are converted once at the persistence boundary.
  return value.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(value)
    ? localDateTimeAtPrecise(value, fallback)
    : value.slice(0, 19)
}

function insertWorkRecord(rec: {
  id: string
  content: string
  app: string | null
  task: string | null
  source: WorkRecordSource
  derivedBy: 'history' | 'legacy'
  segmentId: string | null
  startAt: string
  endAt: string
  confidence: number
  evidenceCount: number
  summaryHash: string | null
  createdAt: string
}): WorkRecord {
  getDb().prepare(
    `INSERT INTO work_records (
      id, content, app, task, evidence_source, segment_id, start_at, end_at,
      confidence, evidence_count, summary_hash, derived_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.id,
    rec.content,
    rec.app,
    rec.task,
    rec.source,
    rec.segmentId,
    rec.startAt,
    rec.endAt,
    rec.confidence,
    rec.evidenceCount,
    rec.summaryHash,
    rec.derivedBy,
    rec.createdAt
  )
  getDb().prepare(
    'DELETE FROM work_records WHERE id NOT IN (SELECT id FROM work_records ORDER BY COALESCE(end_at, created_at) DESC LIMIT ?)'
  ).run(WORK_RECORDS_CAP)
  return rowToWorkRecord({
    id: rec.id,
    content: rec.content,
    app: rec.app,
    task: rec.task,
    evidence_source: rec.source,
    derived_by: rec.derivedBy,
    segment_id: rec.segmentId,
    start_at: rec.startAt,
    end_at: rec.endAt,
    confidence: rec.confidence,
    evidence_count: rec.evidenceCount,
    summary_hash: rec.summaryHash,
    created_at: rec.createdAt
  })
}

export function addWorkRecord(w: {
  content: string
  app: string | null
  task?: string | null
  source?: WorkRecordSource
  derivedBy?: 'legacy'
  startAt?: string
  endAt?: string
  confidence?: number
  evidenceCount?: number
  segmentId?: string | null
  summaryHash?: string | null
  createdAt?: string
}): WorkRecord {
  const createdAt = w.createdAt?.slice(0, 19) || localNow()
  const rec = {
    id: randomUUID(),
    content: w.content.slice(0, 200),
    app: w.app,
    task: normalizeTaskLabel(w.task),
    source: w.source ?? 'ocr',
    derivedBy: w.derivedBy ?? 'legacy' as const,
    segmentId: w.segmentId ?? null,
    startAt: normalizeWorkTimestamp(w.startAt, createdAt),
    endAt: normalizeWorkTimestamp(w.endAt, normalizeWorkTimestamp(w.startAt, createdAt)),
    confidence: Math.min(1, Math.max(0, Number(w.confidence) || 0.5)),
    evidenceCount: Math.max(0, Math.trunc(Number(w.evidenceCount) || 1)),
    summaryHash: w.summaryHash ?? null,
    createdAt
  }
  return insertWorkRecord(rec)
}

/** Upsert one History-derived record by segment; a changed summary updates in place. */
export function upsertHistoryWorkRecord(input: HistoryDerivedWorkRecordInput): WorkRecord {
  const fallback = localNow()
  const startAt = normalizeWorkTimestamp(input.startAt, fallback)
  const endAt = normalizeWorkTimestamp(input.endAt, startAt)
  const content = input.content.slice(0, 200)
  const app = input.app?.slice(0, 80) ?? null
  const task = normalizeTaskLabel(input.task)
  const confidence = Math.min(1, Math.max(0, Number(input.confidence) || 0))
  const evidenceCount = Math.max(0, Math.trunc(Number(input.evidenceCount) || 0))
  const existing = getDb().prepare(
    "SELECT * FROM work_records WHERE derived_by = 'history' AND segment_id = ? LIMIT 1"
  ).get(input.segmentId) as WorkRecordRow | undefined
  if (existing) {
    const unchanged =
      existing.content === content &&
      existing.app === app &&
      existing.task === task &&
      existing.start_at === startAt &&
      existing.end_at === endAt &&
      Number(existing.confidence) === confidence &&
      Number(existing.evidence_count) === evidenceCount &&
      existing.summary_hash === input.summaryHash
    if (!unchanged) {
      getDb().prepare(
        `UPDATE work_records
         SET content = ?, app = ?, task = ?, start_at = ?, end_at = ?,
             confidence = ?, evidence_count = ?, summary_hash = ?, created_at = ?
         WHERE id = ?`
      ).run(content, app, task, startAt, endAt, confidence, evidenceCount, input.summaryHash, endAt, existing.id)
    }
    return rowToWorkRecord({
      ...existing,
      content,
      app,
      task,
      start_at: startAt,
      end_at: endAt,
      confidence,
      evidence_count: evidenceCount,
      summary_hash: input.summaryHash,
      created_at: endAt
    })
  }

  return insertWorkRecord({
    id: `history-work-${input.segmentId}`,
    content,
    app,
    task,
    source: 'accessibility',
    derivedBy: 'history',
    segmentId: input.segmentId,
    startAt,
    endAt,
    confidence,
    evidenceCount,
    summaryHash: input.summaryHash,
    createdAt: endAt
  })
}

/** Remove only the current derived record; legacy OCR records are untouched. */
export function removeHistoryWorkRecord(segmentId: string): void {
  getDb().prepare("DELETE FROM work_records WHERE derived_by = 'history' AND segment_id = ?").run(segmentId)
}

/** Remove History-derived records for a set of segments and return actual row ids. */
export function removeHistoryWorkRecords(segmentIds: string[]): string[] {
  const ids = [...new Set(segmentIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (!ids.length) return []
  const select = getDb().prepare("SELECT id FROM work_records WHERE derived_by = 'history' AND segment_id = ?")
  const remove = getDb().prepare("DELETE FROM work_records WHERE derived_by = 'history' AND segment_id = ?")
  const deleted: string[] = []
  getDb().transaction((values: string[]) => {
    for (const segmentId of values) {
      const rows = select.all(segmentId) as { id: string }[]
      for (const row of rows) deleted.push(row.id)
      remove.run(segmentId)
    }
  })(ids)
  return deleted
}

/** 某天（YYYY-MM-DD）的工作记录，按时间正序。 */
export function listWorkRecords(day: string): WorkRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM work_records WHERE COALESCE(start_at, created_at) LIKE ? ORDER BY COALESCE(start_at, created_at), created_at')
    .all(`${day}%`) as WorkRecordRow[]
  return rows.map(rowToWorkRecord)
}

export function deleteWorkRecord(id: string): void {
  getDb().prepare('DELETE FROM work_records WHERE id = ?').run(id)
}

/** 近 N 天工作记录（供个人记忆归纳/活动时间线）。 */
export function listWorkRecordsSince(sinceDay: string): WorkRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM work_records WHERE COALESCE(start_at, created_at) >= ? ORDER BY COALESCE(start_at, created_at), created_at')
    .all(sinceDay) as WorkRecordRow[]
  return rows.map(rowToWorkRecord)
}

/** 时间范围内的工作记录（含端点，日键比较）。给数据导出用，免得 maintenance 复用本模块的行映射。 */
export function listWorkRecordsBetween(fromDay: string, toDay: string): WorkRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM work_records WHERE COALESCE(start_at, created_at) >= ? AND COALESCE(start_at, created_at) <= ? ORDER BY COALESCE(start_at, created_at), created_at')
    .all(fromDay, toDay) as WorkRecordRow[]
  return rows.map(rowToWorkRecord)
}

