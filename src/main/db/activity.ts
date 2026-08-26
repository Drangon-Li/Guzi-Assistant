// Hybrid History v2 的落盘部分：只持久化聚合片段与脱敏 OCR 证据，不落盘原始事件。
import { getDb } from './connection.ts'
import type { OcrEvidenceRecord } from '@shared/types'

// ---------- Hybrid History v2（只持久化聚合片段和脱敏 OCR 证据，不落盘原始事件） ----------

export function addOcrEvidence(evidence: OcrEvidenceRecord): void {
  getDb().prepare(
    `INSERT INTO ocr_evidence (
      id, event_id, segment_id, occurred_at, app_name, bundle_id, window_title,
      semantic_score, trigger_reason, redaction_hits, redacted_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    evidence.id,
    evidence.eventId,
    evidence.segmentId,
    evidence.occurredAt,
    evidence.appName,
    evidence.bundleId,
    evidence.windowTitle,
    Math.max(0, Math.min(100, Math.round(evidence.semanticScore))),
    evidence.triggerReason,
    JSON.stringify(evidence.redactionHits),
    evidence.redactedText.slice(0, 20_000),
    evidence.createdAt
  )
}

export function listOcrEvidence(limit = 40): OcrEvidenceRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM ocr_evidence ORDER BY occurred_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    eventId: row.event_id == null ? null : String(row.event_id),
    segmentId: row.segment_id == null ? null : String(row.segment_id),
    occurredAt: String(row.occurred_at),
    appName: row.app_name == null ? null : String(row.app_name),
    bundleId: row.bundle_id == null ? null : String(row.bundle_id),
    windowTitle: row.window_title == null ? null : String(row.window_title),
    semanticScore: Number(row.semantic_score),
    triggerReason: String(row.trigger_reason),
    redactionHits: JSON.parse(String(row.redaction_hits || '[]')) as string[],
    redactedText: String(row.redacted_text),
    createdAt: String(row.created_at)
  }))
}
