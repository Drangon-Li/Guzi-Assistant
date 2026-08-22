import { createHash } from 'node:crypto'
import type { RolloutComparison } from '../../shared/history.ts'

/**
 * Aggregate-only inputs for the History v2 rollout comparison. The inputs may
 * contain labels because they are used to calculate a stable duplicate key,
 * but no labels are returned from this module.
 */
export interface RolloutSegmentInput {
  id: string
  bucketKind?: '10m' | '6h'
  bucketStart: string
  bucketEnd: string
  eventCount: number
  meaningfulEventCount: number
  suppressedEventCount?: number
  summary?: string | null
}

export interface RolloutSummaryInput {
  id: string
  level: '10m' | '6h'
  bucketStart: string
  bucketEnd: string
  sourceSegmentIds: string[]
}

export interface RolloutWorkInput {
  id: string
  derivedBy: 'history' | 'legacy'
  segmentId?: string | null
  app?: string | null
  task?: string | null
  content?: string | null
  startAt: string
  endAt: string
  summaryHash?: string | null
}

export interface RolloutComparisonInput {
  nowMs: number
  retentionMs: number
  legacySegments: readonly RolloutSegmentInput[]
  historySegments: readonly RolloutSegmentInput[]
  summaries: readonly RolloutSummaryInput[]
  workRecords: readonly RolloutWorkInput[]
}

function finiteMs(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function overlaps(value: { bucketStart: string; bucketEnd: string }, fromMs: number, toMs: number): boolean {
  const start = finiteMs(value.bucketStart)
  const end = finiteMs(value.bucketEnd)
  return start !== null && end !== null && end > fromMs && start < toMs && end > start
}

function workOverlaps(value: RolloutWorkInput, fromMs: number, toMs: number): boolean {
  const start = finiteMs(value.startAt)
  const end = finiteMs(value.endAt)
  return start !== null && end !== null && end >= fromMs && start < toMs && end >= start
}

function count(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function bucketStart(value: string): string {
  const timestamp = finiteMs(value)
  if (timestamp === null) return ''
  return new Date(Math.floor(timestamp / 600_000) * 600_000).toISOString()
}

function duplicateKey(value: RolloutWorkInput): string {
  const segment = normalize(value.segmentId)
  if (value.derivedBy === 'history' && segment) return `segment:${segment}`
  return semanticKey(value)
}

function semanticKey(value: RolloutWorkInput): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        bucket: bucketStart(value.startAt),
        app: normalize(value.app),
        task: normalize(value.task),
        content: normalize(value.content)
      })
    )
    .digest('hex')
  return `work:${hash}`
}

function duplicateCount(rows: readonly RolloutWorkInput[]): { total: number; duplicates: number; keys: Set<string> } {
  const keys = new Set<string>()
  for (const row of rows) keys.add(duplicateKey(row))
  return { total: rows.length, duplicates: Math.max(0, rows.length - keys.size), keys }
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0
  return Number((numerator / denominator).toFixed(4))
}

/** Build a privacy-safe comparison for one retention window. */
export function buildRolloutComparison(input: RolloutComparisonInput): RolloutComparison {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now()
  const retentionMs = Number.isFinite(input.retentionMs) && input.retentionMs > 0 ? input.retentionMs : 48 * 60 * 60 * 1000
  const fromMs = nowMs - retentionMs
  const toMs = nowMs
  // Legacy activity_segments also contain 6-hour rollups. The rollout baseline
  // is the event-level 10-minute stream; including both granularities would
  // count the same event twice. Undefined remains compatible with old callers.
  const legacySegments = input.legacySegments.filter(
    (row) => (row.bucketKind === undefined || row.bucketKind === '10m') && overlaps(row, fromMs, toMs)
  )
  const historySegments = input.historySegments.filter((row) => overlaps(row, fromMs, toMs))
  const summaries = input.summaries.filter((row) => overlaps(row, fromMs, toMs))
  const workRecords = input.workRecords.filter((row) => workOverlaps(row, fromMs, toMs))
  const legacyWork = workRecords.filter((row) => row.derivedBy === 'legacy')
  const historyWork = workRecords.filter((row) => row.derivedBy === 'history')
  const legacyDuplicates = duplicateCount(legacyWork)
  const historyDuplicates = duplicateCount(historyWork)
  const legacySemanticKeys = new Set(legacyWork.map(semanticKey))
  const historySemanticKeys = new Set(historyWork.map(semanticKey))
  const overlapKeys = new Set([...legacySemanticKeys].filter((key) => historySemanticKeys.has(key)))
  const totalPathKeys = new Set([...legacySemanticKeys, ...historySemanticKeys]).size
  const legacyTenMinuteSummaryCount = legacySegments.filter((row) => Boolean(row.summary?.trim())).length

  return {
    schemaVersion: 1,
    windowStart: new Date(fromMs).toISOString(),
    windowEnd: new Date(toMs).toISOString(),
    legacy: {
      segmentCount: legacySegments.length,
      eventCount: legacySegments.reduce((sum, row) => sum + count(row.eventCount), 0),
      meaningfulEventCount: legacySegments.reduce((sum, row) => sum + count(row.meaningfulEventCount), 0),
      summaryCount: legacyTenMinuteSummaryCount,
      tenMinuteSummaryCount: legacyTenMinuteSummaryCount
    },
    history: {
      segmentCount: historySegments.length,
      eventCount: historySegments.reduce((sum, row) => sum + count(row.eventCount), 0),
      meaningfulEventCount: historySegments.reduce((sum, row) => sum + count(row.meaningfulEventCount), 0),
      suppressedEventCount: historySegments.reduce((sum, row) => sum + count(row.suppressedEventCount), 0),
      summaryCount: summaries.length,
      tenMinuteSummaryCount: summaries.filter((row) => row.level === '10m').length,
      sixHourSummaryCount: summaries.filter((row) => row.level === '6h').length
    },
    workRecords: {
      legacyCount: legacyWork.length,
      historyCount: historyWork.length,
      legacyDuplicateCount: legacyDuplicates.duplicates,
      historyDuplicateCount: historyDuplicates.duplicates,
      legacyDuplicateRate: ratio(legacyDuplicates.duplicates, legacyWork.length),
      historyDuplicateRate: ratio(historyDuplicates.duplicates, historyWork.length),
      crossPathOverlapCount: overlapKeys.size,
      crossPathOverlapRate: ratio(overlapKeys.size, totalPathKeys)
    }
  }
}
