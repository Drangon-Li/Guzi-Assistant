import type { HistoryStoreHealth } from './types'

/** Privacy-minimized view returned by History queries. */
export interface HistorySummaryView {
  id: string
  level: '10m' | '6h'
  bucketStart: string
  bucketEnd: string
  startAt: string
  endAt: string
  apps: string[]
  windowThemes: string[]
  activityTypes: string[]
  activityTypeCounts: HistoryActivityStat[]
  taskClues: string[]
  confidence: number
  evidenceCount: number
  meaningfulEvidenceCount: number
  suppressedEventCount: number
  sourceSegmentIds: string[]
  source: 'local' | 'model' | 'hybrid'
  summary: string
  /** Stable task/project label shared with work records and focus aggregation. */
  focusTask?: string | null
  /** Semantic primary content; optional for summaries written before focus v2. */
  focus?: string | null
  progress?: string | null
  outcome?: string | null
}

/** Aggregate fallback view when a summary is not available yet. */
export interface HistorySegmentView {
  id: string
  bucketStart: string
  bucketEnd: string
  eventCount: number
  meaningfulEventCount: number
  suppressedEventCount: number
  apps: string[]
  activityTypes: string[]
  activityTypeCounts: HistoryActivityStat[]
  urlHosts: string[]
}

export interface HistoryActivityStat {
  type: string
  count: number
}

/**
 * Normalize a host-only privacy setting. Full URLs, paths, credentials and
 * whitespace are rejected so an allow/deny list can never become a URL store.
 */
export function normalizeHistoryHost(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const host = value.normalize('NFKC').trim().toLowerCase().replace(/\.$/, '')
  if (!host || host.length > 255 || /[\s/?#@]/.test(host)) return null
  if (/^[a-z][a-z\d+.-]*:\/\//.test(host)) return null

  const bracketed = host.match(/^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i)
  if (bracketed) {
    if (bracketed[2] != null && (Number(bracketed[2]) < 1 || Number(bracketed[2]) > 65535)) return null
    return host
  }

  const match = host.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i)
  if (!match || match[1].includes('..')) return null
  if (match[2] != null && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null
  return host
}

export interface HistoryRange {
  from: string
  to: string
}

export interface HistoryQueryOptions {
  from?: string | null
  to?: string | null
  limit?: number
  /** Return aggregate segment fallbacks for uncovered ranges. */
  includeSegments?: boolean
}

export interface HistorySearchOptions extends HistoryQueryOptions {
  query?: string | null
  app?: string | null
}

export interface HistoryRecentResult {
  range: HistoryRange
  sixHour: HistorySummaryView[]
  tenMinute: HistorySummaryView[]
  segments: HistorySegmentView[]
  fallbackUsed: boolean
}

export interface HistorySearchResult extends HistoryRecentResult {
  query: string
}

export interface HistorySummarizeResult extends HistoryRecentResult {
  run: {
    tenMinuteSummaries: number
    sixHourSummaries: number
    /** Optional on older clients; counts actual source/model changes. */
    tenMinuteChanged?: number
    sixHourChanged?: number
    summariesPruned?: number
    modelSuccesses: number
    modelFailures: number
  }
}

export interface HistoryStatus {
  enabled: boolean
  paused: boolean
  health: HistoryStoreHealth
  retentionExpiresAt: string | null
  summaryCounts: { tenMinute: number; sixHour: number }
  /** Aggregate-only dual-write comparison; null while History is disabled. */
  rolloutComparison: RolloutComparison | null
}

export interface RolloutComparison {
  schemaVersion: 1
  windowStart: string
  windowEnd: string
  legacy: {
    segmentCount: number
    eventCount: number
    meaningfulEventCount: number
    summaryCount: number
    /** Explicit 10-minute baseline count; summaryCount remains a compatibility alias. */
    tenMinuteSummaryCount: number
  }
  history: {
    segmentCount: number
    eventCount: number
    meaningfulEventCount: number
    suppressedEventCount: number
    summaryCount: number
    tenMinuteSummaryCount: number
    sixHourSummaryCount: number
  }
  workRecords: {
    legacyCount: number
    historyCount: number
    legacyDuplicateCount: number
    historyDuplicateCount: number
    legacyDuplicateRate: number
    historyDuplicateRate: number
    crossPathOverlapCount: number
    crossPathOverlapRate: number
  }
}

export interface HistoryDeleteResult {
  range: HistoryRange | null
  deletedSegmentIds: string[]
  deletedSummaryIds: string[]
  deletedWorkRecordIds: string[]
}
