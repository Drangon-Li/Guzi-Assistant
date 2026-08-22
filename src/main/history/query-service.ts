import { ACTIVITY_RETENTION_MS } from '../../shared/activity-events.ts'
import { redactSensitive } from '../../shared/sensitive.ts'
import type {
  HistoryDeleteResult,
  HistoryRange,
  HistoryRecentResult,
  HistorySearchOptions,
  HistorySearchResult,
  HistorySegmentView,
  HistoryStatus,
  HistorySummarizeResult,
  HistorySummaryView,
  HistoryQueryOptions,
  HistoryActivityStat
} from '../../shared/history.ts'
import type { HistorySegmentSnapshot } from './event-store.ts'
import type { HistorySegmentIndex, HistorySegmentMetadata } from './segment-index.ts'
import { parseHistorySummaryDocument, type HistorySummaryDocument, type SummaryRunResult } from './summarizer.ts'
import type { HistorySummaryIndex, HistorySummaryRecord } from './summary-index.ts'

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 120

export interface HistorySnapshotReader {
  listSegmentSnapshots(): Promise<HistorySegmentSnapshot[]>
  readSegmentSnapshot(id: string): Promise<HistorySegmentSnapshot | null>
}

export interface HistoryQueryServiceDependencies {
  summaryIndex: HistorySummaryIndex
  segmentIndex: HistorySegmentIndex
  getStore: () => Promise<HistorySnapshotReader | null>
  getStatus: () => HistoryStatus
  summarize: () => Promise<SummaryRunResult>
  pause: () => Promise<HistoryStatus>
  resume: () => Promise<HistoryStatus>
  deleteRange: (fromMs: number, toMs: number) => Promise<HistoryDeleteResult>
  clear: () => Promise<HistoryDeleteResult>
  now?: () => number
}

interface NormalizedRange {
  fromMs: number
  toMs: number
  range: HistoryRange
}

function stringList(value: unknown, limit = 32): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => redactSensitive(item).text.trim())
    .filter(Boolean)
    .slice(0, limit)
}

function activityStats(value: unknown, limit = 32): HistoryActivityStat[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): HistoryActivityStat | null => {
      if (!item || typeof item !== 'object') return null
      const raw = item as { type?: unknown; count?: unknown }
      const type = typeof raw.type === 'string' ? redactSensitive(raw.type).text.trim() : ''
      const count = Number(raw.count)
      if (!type || !Number.isFinite(count) || count < 0) return null
      return { type: type.slice(0, 80), count: Math.max(0, Math.trunc(count)) }
    })
    .filter((item): item is HistoryActivityStat => item !== null)
    .slice(0, limit)
}

function finiteDate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function normalizeLimit(value: unknown): number {
  if (value == null) return DEFAULT_LIMIT
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)))
}

function normalizeRange(options: HistoryQueryOptions, nowMs: number): NormalizedRange {
  const defaultTo = nowMs
  const defaultFrom = nowMs - ACTIVITY_RETENTION_MS
  const fromMs = options.from == null || options.from === '' ? defaultFrom : finiteDate(options.from)
  const toMs = options.to == null || options.to === '' ? defaultTo : finiteDate(options.to)
  if (fromMs == null || toMs == null) throw new RangeError('history range must use ISO timestamps')
  if (fromMs >= toMs) throw new RangeError('history range must satisfy from < to')
  return { fromMs, toMs, range: { from: iso(fromMs), to: iso(toMs) } }
}

function normalizeDeleteRange(options: HistoryQueryOptions, nowMs: number): NormalizedRange {
  if (options.from == null || options.from === '' || options.to == null || options.to === '')
    throw new RangeError('history delete range requires explicit from and to timestamps')
  return normalizeRange(options, nowMs)
}

function overlaps(start: string, end: string, fromMs: number, toMs: number): boolean {
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > fromMs && startMs < toMs
}

function normalizedSearch(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase() : ''
}

function documentFor(record: HistorySummaryRecord): HistorySummaryDocument | null {
  return parseHistorySummaryDocument(record.summaryJson)
}

function sourceIdsForSummary(record: HistorySummaryRecord): string[] {
  const document = documentFor(record)
  return document?.sourceSegmentIds?.length ? document.sourceSegmentIds : document ? [record.id] : []
}

function summaryView(record: HistorySummaryRecord): HistorySummaryView {
  const document = documentFor(record)
  const source = document?.source === 'model' || document?.source === 'hybrid' ? document.source : 'local'
  return {
    id: record.id,
    level: record.level,
    bucketStart: document?.bucketStart ?? record.bucketStart,
    bucketEnd: document?.bucketEnd ?? record.bucketEnd,
    startAt: document?.startAt ?? record.bucketStart,
    endAt: document?.endAt ?? record.bucketEnd,
    apps: stringList(document?.apps),
    windowThemes: stringList(document?.windowThemes),
    activityTypes: stringList(document?.activityTypes),
    activityTypeCounts: activityStats(document?.activityTypeCounts),
    taskClues: stringList(document?.taskClues),
    confidence: typeof document?.confidence === 'number' && Number.isFinite(document.confidence)
      ? Math.min(1, Math.max(0, document.confidence))
      : 0,
    evidenceCount: Math.max(0, Math.trunc(Number(document?.evidenceCount ?? 0))),
    meaningfulEvidenceCount: Math.max(0, Math.trunc(Number(document?.meaningfulEvidenceCount ?? 0))),
    suppressedEventCount: Math.max(0, Math.trunc(Number(document?.suppressedEventCount ?? 0))),
    sourceSegmentIds: stringList(document?.sourceSegmentIds, 128),
    source,
    // observedData is intentionally omitted from this public projection.
    summary: typeof document?.summary === 'string'
      ? redactSensitive(document.summary).text.slice(0, 240)
      : redactSensitive(record.summaryText ?? '').text.slice(0, 240),
    focusTask: typeof document?.focusTask === 'string' ? redactSensitive(document.focusTask).text.slice(0, 100) : null,
    focus: typeof document?.focus === 'string' ? redactSensitive(document.focus).text.slice(0, 160) : null,
    progress: typeof document?.progress === 'string' ? redactSensitive(document.progress).text.slice(0, 100) : null,
    outcome: typeof document?.outcome === 'string' ? redactSensitive(document.outcome).text.slice(0, 120) : null
  }
}

function segmentView(snapshot: HistorySegmentSnapshot): HistorySegmentView {
  const apps = new Map<string, number>()
  const kinds = new Map<string, number>()
  const hosts = new Set<string>()
  for (const event of snapshot.events) {
    if (event.app_name) apps.set(event.app_name, (apps.get(event.app_name) ?? 0) + 1)
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1)
    if (event.url_host) hosts.add(event.url_host)
  }
  return {
    id: snapshot.metadata.id,
    bucketStart: snapshot.metadata.bucketStart,
    bucketEnd: snapshot.metadata.bucketEnd,
    eventCount: snapshot.metadata.eventCount,
    meaningfulEventCount: snapshot.metadata.meaningfulEventCount,
    suppressedEventCount: snapshot.metadata.suppressedEventCount,
    apps: [...apps.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name).slice(0, 16),
    activityTypes: [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind]) => kind).slice(0, 16),
    activityTypeCounts: [...kinds.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 16)
      .map(([type, count]) => ({ type, count })),
    urlHosts: [...hosts].slice(0, 16)
  }
}

function metadataSegmentView(metadata: HistorySegmentMetadata): HistorySegmentView {
  return {
    id: metadata.id,
    bucketStart: metadata.bucketStart,
    bucketEnd: metadata.bucketEnd,
    eventCount: metadata.eventCount,
    meaningfulEventCount: metadata.meaningfulEventCount,
    suppressedEventCount: metadata.suppressedEventCount,
    apps: [],
    activityTypes: [],
    activityTypeCounts: [],
    urlHosts: []
  }
}

function summaryMatches(view: HistorySummaryView, query: string, app: string): boolean {
  if (app && !view.apps.some((item) => normalizedSearch(item).includes(app))) return false
  if (!query) return true
  const haystack = [
    view.summary,
    view.focusTask ?? '',
    view.focus ?? '',
    view.progress ?? '',
    view.outcome ?? '',
    ...view.apps,
    ...view.windowThemes,
    ...view.activityTypes,
    ...view.taskClues,
    ...view.sourceSegmentIds
  ].map(normalizedSearch).join('\n')
  return haystack.includes(query)
}

function snapshotMatches(snapshot: HistorySegmentSnapshot, query: string, app: string): boolean {
  return snapshot.events.some((event) => {
    if (app && !normalizedSearch(event.app_name).includes(app)) return false
    if (!query) return true
    return [event.app_name, event.bundle_id, event.window_title, event.url_host, event.target_role, event.target_label, event.command, event.kind]
      .map(normalizedSearch)
      .some((value) => value.includes(query))
  })
}

function sortNewest<T extends { startAt?: string; bucketStart: string }>(items: T[]): T[] {
  return items.sort((a, b) => (Date.parse(b.startAt ?? b.bucketStart) || 0) - (Date.parse(a.startAt ?? a.bucketStart) || 0))
}

/**
 * Read/query facade shared by MCP and IPC. It never exposes observedData or
 * raw event labels; raw snapshots are used only internally for search/fallback.
 */
export class HistoryQueryService {
  private readonly deps: HistoryQueryServiceDependencies

  constructor(deps: HistoryQueryServiceDependencies) {
    this.deps = deps
  }

  status(): HistoryStatus {
    return this.deps.getStatus()
  }

  async recent(options: HistoryQueryOptions = {}): Promise<HistoryRecentResult> {
    const nowMs = this.deps.now?.() ?? Date.now()
    const normalized = normalizeRange(options, nowMs)
    if (!this.deps.getStatus().enabled)
      return { range: normalized.range, sixHour: [], tenMinute: [], segments: [], fallbackUsed: false }
    const limit = normalizeLimit(options.limit)
    const sixHourRecords = this.deps.summaryIndex
      .list('6h')
      .filter((record) => record.status === 'ready' && overlaps(record.bucketStart, record.bucketEnd, normalized.fromMs, normalized.toMs))
    const sixHour = sortNewest(sixHourRecords.map(summaryView)).slice(0, limit)
    const tenMinuteRecords = this.deps.summaryIndex
      .list('10m')
      .filter((record) => record.status === 'ready' && overlaps(record.bucketStart, record.bucketEnd, normalized.fromMs, normalized.toMs))
    const tenMinute = sortNewest(tenMinuteRecords.map(summaryView)).slice(0, limit)
    const covered = new Set([
      ...sixHourRecords.flatMap(sourceIdsForSummary),
      ...tenMinuteRecords.flatMap(sourceIdsForSummary)
    ])
    const segments = await this.fallbackSegments(normalized, limit, covered, '', '', options.includeSegments !== false)
    return {
      range: normalized.range,
      sixHour,
      tenMinute,
      segments: segments.items,
      fallbackUsed: segments.used
    }
  }

  async search(options: HistorySearchOptions = {}): Promise<HistorySearchResult> {
    const nowMs = this.deps.now?.() ?? Date.now()
    const normalized = normalizeRange(options, nowMs)
    if (!this.deps.getStatus().enabled)
      return { range: normalized.range, query: typeof options.query === 'string' ? options.query : '', sixHour: [], tenMinute: [], segments: [], fallbackUsed: false }
    const limit = normalizeLimit(options.limit)
    const query = normalizedSearch(options.query)
    const app = normalizedSearch(options.app)
    const sixHourRecords = this.deps.summaryIndex
      .list('6h')
      .filter((record) => record.status === 'ready' && overlaps(record.bucketStart, record.bucketEnd, normalized.fromMs, normalized.toMs))
    const sixHourMatches = sixHourRecords
      .map((record) => ({ record, view: summaryView(record) }))
      .filter(({ view }) => summaryMatches(view, query, app))
    const sixHour = sortNewest(sixHourMatches.map(({ view }) => view)).slice(0, limit)
    const tenMinuteRecords = this.deps.summaryIndex
      .list('10m')
      .filter((record) => record.status === 'ready' && overlaps(record.bucketStart, record.bucketEnd, normalized.fromMs, normalized.toMs))
    const tenMinute = sortNewest(tenMinuteRecords.map(summaryView).filter((view) => summaryMatches(view, query, app))).slice(0, limit)
    const covered = new Set([
      ...sixHourMatches.flatMap(({ record }) => sourceIdsForSummary(record)),
      ...tenMinuteRecords
        .map((record) => ({ record, view: summaryView(record) }))
        .filter(({ view }) => !query || summaryMatches(view, query, app))
        .flatMap(({ record }) => sourceIdsForSummary(record))
    ])
    const segments = await this.fallbackSegments(
      normalized,
      limit,
      covered,
      query,
      app,
      options.includeSegments !== false
    )
    return {
      range: normalized.range,
      query: typeof options.query === 'string' ? options.query : '',
      sixHour,
      tenMinute,
      segments: segments.items,
      fallbackUsed: segments.used
    }
  }

  async summarize(options: HistoryQueryOptions = {}): Promise<HistorySummarizeResult> {
    const run = await this.deps.summarize()
    return { ...(await this.recent(options)), run }
  }

  pause(): Promise<HistoryStatus> {
    return this.deps.pause()
  }

  resume(): Promise<HistoryStatus> {
    return this.deps.resume()
  }

  clear(): Promise<HistoryDeleteResult> {
    return this.deps.clear()
  }

  deleteRange(options: HistoryQueryOptions = {}): Promise<HistoryDeleteResult> {
    const nowMs = this.deps.now?.() ?? Date.now()
    const normalized = normalizeDeleteRange(options, nowMs)
    return this.deps.deleteRange(normalized.fromMs, normalized.toMs)
  }

  private async fallbackSegments(
    normalized: NormalizedRange,
    limit: number,
    covered: Set<string>,
    query: string,
    app: string,
    enabled: boolean
  ): Promise<{ items: HistorySegmentView[]; used: boolean }> {
    if (!enabled) return { items: [], used: false }
    const store = await this.deps.getStore()
    if (!store) {
      if (query || app) return { items: [], used: false }
      return this.metadataFallback(normalized, limit, covered)
    }

    const indexedInRange = this.deps.segmentIndex
      .list()
      .filter((metadata) => overlaps(metadata.bucketStart, metadata.bucketEnd, normalized.fromMs, normalized.toMs))
    const candidates = indexedInRange
      .filter((metadata) => !covered.has(metadata.id))

    // The index is rebuilt when the store starts, so a non-empty candidate set
    // can be read one segment at a time without touching covered JSONL files.
    if (candidates.length > 0) {
      const items: HistorySegmentView[] = []
      try {
        for (const metadata of candidates) {
          const snapshot = await store.readSegmentSnapshot(metadata.id)
          if (!snapshot || !snapshotMatches(snapshot, query, app)) continue
          items.push(segmentView(snapshot))
        }
      } catch {
        if (query || app) return { items: [], used: false }
        return this.metadataFallback(normalized, limit, covered)
      }
      sortNewest(items)
      return { items: items.slice(0, limit), used: items.length > 0 }
    }

    // Every indexed segment in the range is already represented by a summary.
    // Do not reopen JSONL merely to prove that there is nothing else to return.
    if (indexedInRange.length > 0) return { items: [], used: false }

    // An empty index can mean that writes are still being flushed or that a
    // crash left an orphan sidecar. Let the store reconcile once in that case.
    let snapshots: HistorySegmentSnapshot[]
    try {
      snapshots = await store.listSegmentSnapshots()
    } catch {
      if (query || app) return { items: [], used: false }
      return this.metadataFallback(normalized, limit, covered)
    }
    const items: HistorySegmentView[] = []
    for (const snapshot of snapshots) {
      if (!overlaps(snapshot.metadata.bucketStart, snapshot.metadata.bucketEnd, normalized.fromMs, normalized.toMs)) continue
      if (covered.has(snapshot.metadata.id)) continue
      if (!snapshotMatches(snapshot, query, app)) continue
      items.push(segmentView(snapshot))
    }
    sortNewest(items)
    return { items: items.slice(0, limit), used: items.length > 0 }
  }

  private metadataFallback(
    normalized: NormalizedRange,
    limit: number,
    covered: Set<string>
  ): { items: HistorySegmentView[]; used: boolean } {
    const items = this.deps.segmentIndex
      .list()
      .filter((metadata) => overlaps(metadata.bucketStart, metadata.bucketEnd, normalized.fromMs, normalized.toMs))
      .filter((metadata) => !covered.has(metadata.id))
      .map(metadataSegmentView)
    sortNewest(items)
    return { items: items.slice(0, limit), used: items.length > 0 }
  }
}
