import { randomUUID } from 'crypto'
import {
  ACTIVITY_RETENTION_MS,
  buildActivitySegments,
  dedupeActivityEvents,
  sanitizeWindowTitle,
  shouldRunHardFallback,
  utcTenMinuteBucket,
  type ActivityEvent
} from '../shared/activity-events.ts'
import {
  assessSemanticCompleteness,
  contextKey,
  isHighValueActivityEvent,
  type OcrTriggerReason,
  hybridSegmentFromActivity,
  type OcrEvidence,
  type PrivacyState,
  type SemanticAssessment
} from '../shared/hybrid-history.ts'
import { redactSensitive } from '../shared/sensitive.ts'
import type { SemanticWorkEvidence } from '../shared/semantic-work.ts'
import type { ActivityHistorySegmentRecord, OcrEvidenceRecord, ScreenActivityStatus } from '../shared/types.ts'
import type {
  CollectorEvent,
  CollectorHealth,
  FrontmostCollectorHandle,
  FrontmostContext
} from './frontapp.ts'

export type ActivityScanReason = 'event' | 'hard_fallback' | 'interval' | 'manual' | 'semantic_only'

export interface ActivityScanDecision {
  run: boolean
  reason: ActivityScanReason | 'observer_unavailable' | 'waiting'
}

export interface AccessibilityWorkContext extends SemanticWorkEvidence {
  eventId: string
  occurredAtMs: number
  eventKind: string
  segmentId: string
  highValueEvent: boolean
}

const MAX_EVENTS = 5000
const BROWSER_BUNDLES = new Set([
  'com.apple.Safari',
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'org.mozilla.firefox'
])
const PRIVATE_TITLE =
  /private browsing|private window|incognito|inprivate|无痕|無痕|私密浏览|私密瀏覽|シークレット|プライベート|시크릿|프라이빗/i

let events: ActivityEvent[] = []
let assessments = new Map<string, SemanticAssessment>()
let startedAtMs = Date.now()
let lastContext: FrontmostContext | null = null
let pendingContextChange = false
let observer: ScreenActivityStatus['observer'] = 'waiting'
let observerDetail: string | null = null
let collectorState: ScreenActivityStatus['collector'] = 'stopped'
let collectorDetail: string | null = null
let collectorRestartCount = 0
let collectorAccessibility: ScreenActivityStatus['accessibility'] = 'unknown'
let collectorHandle: FrontmostCollectorHandle | null = null
let lastEventAtMs: number | null = null
let lastScanAtMs: number | null = null
let lastScanReason: ActivityScanReason | null = null
let latestAssessment: SemanticAssessment = {
  semanticLevel: 'empty',
  score: 0,
  reasonCodes: ['no_context'],
  privacyState: 'normal'
}
let latestContextKey = ''
let consecutivePartialCount = 0
let ocrFallbackCount = 0
let ocrFallbackReasons: Record<string, number> = {}
let lastOcrAtMs: number | null = null
let lastOcrContextKey: string | null = null
let observerFailureOcrUsed = false
let ocrEvidence: OcrEvidence[] = []
let semanticWorkClassifier: ((context: AccessibilityWorkContext) => void) | null = null
let workClassificationStatus: ScreenActivityStatus['workClassificationStatus'] = 'idle'
let workClassificationSource: ScreenActivityStatus['workClassificationSource'] = null
let workClassificationAtMs: number | null = null
let workClassificationDetail: string | null = null
let workClassificationCount = 0

interface ActivityHistoryPersistence {
  upsertSegment: (record: ActivityHistorySegmentRecord) => void
  addOcrEvidence: (record: OcrEvidenceRecord) => void
}

let persistence: ActivityHistoryPersistence | null = null

export function configureActivityHistoryPersistence(next: ActivityHistoryPersistence | null): void {
  persistence = next
}

export function configureSemanticWorkClassifier(
  next: ((context: AccessibilityWorkContext) => void) | null
): void {
  semanticWorkClassifier = next
}

export function setWorkClassificationStatus(input: {
  status: ScreenActivityStatus['workClassificationStatus']
  source?: ScreenActivityStatus['workClassificationSource']
  detail?: string | null
  atMs?: number | null
  increment?: boolean
}): void {
  workClassificationStatus = input.status
  if (input.source !== undefined) workClassificationSource = input.source
  if (input.detail !== undefined) workClassificationDetail = input.detail
  if (input.atMs !== undefined) workClassificationAtMs = input.atMs
  if (input.increment) workClassificationCount += 1
}

const isoOrNull = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString()

function appendEvent(event: ActivityEvent, nowMs: number): void {
  events = dedupeActivityEvents([...events, event])
    .filter((item) => item.occurredAtMs >= nowMs - ACTIVITY_RETENTION_MS)
    .slice(-MAX_EVENTS)
  for (const id of assessments.keys()) {
    const assessment = events.some((item) => item.id === id)
    if (!assessment) assessments.delete(id)
  }
  lastEventAtMs = event.occurredAtMs
}

function safeContext(context: FrontmostContext): FrontmostContext {
  return {
    name: context.name.trim().slice(0, 80),
    bundleId: context.bundleId.trim().slice(0, 160),
    windowTitle: sanitizeWindowTitle(redactSensitive(context.windowTitle).text),
    focusedRole: context.focusedRole?.trim().slice(0, 80),
    safeLabel: sanitizeWindowTitle(redactSensitive(context.safeLabel ?? '').text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160),
    eventKind: context.eventKind,
    eventSource: context.eventSource
  }
}

export function isPrivateBrowsingContext(context: FrontmostContext): boolean {
  return BROWSER_BUNDLES.has(context.bundleId) && PRIVATE_TITLE.test(context.windowTitle)
}

export interface RecordContextOptions {
  suppressed: boolean
  privacyState?: PrivacyState
  /** collector 能读到上下文但没有 Accessibility 语义时，仍保留事件并标记为降级。 */
  observerHealthy?: boolean
  nowMs?: number
  eventKind?: FrontmostContext['eventKind']
  eventSource?: FrontmostContext['eventSource']
}

export function recordFrontmostContext(
  context: FrontmostContext,
  options: RecordContextOptions
): ActivityEvent | null {
  const nowMs = options.nowMs ?? Date.now()
  observer = 'healthy'
  observerDetail = null
  const safe = safeContext({ ...context, eventKind: options.eventKind ?? context.eventKind, eventSource: options.eventSource ?? context.eventSource })
  const previous = lastContext
  const appChanged = !previous || previous.name !== safe.name || previous.bundleId !== safe.bundleId
  const contextChanged =
    appChanged ||
    !previous ||
    previous.windowTitle !== safe.windowTitle ||
    previous.focusedRole !== safe.focusedRole ||
    previous.safeLabel !== safe.safeLabel ||
    safe.eventKind === 'ax_focus_changed' ||
    safe.eventKind === 'ax_attribute_changed'
  lastContext = safe
  if (!contextChanged) return null

  const event: ActivityEvent = {
    id: randomUUID(),
    occurredAtMs: nowMs,
    kind: safe.eventKind ?? (appChanged ? 'app_activated' : 'window_changed'),
    source: safe.eventSource === 'accessibility' ? 'accessibility' : safe.eventSource === 'collector' ? 'collector' : 'workspace',
    ...(options.suppressed
      ? { suppressed: true }
      : {
          appName: safe.name || null,
          bundleId: safe.bundleId || null,
          windowTitle: safe.windowTitle || null,
          focusedRole: safe.focusedRole || null,
          safeLabel: safe.safeLabel || null
        })
  }
  const privacyState = options.privacyState ?? (options.suppressed ? 'excluded' : 'normal')
  const assessment = assessSemanticCompleteness({
    appName: safe.name,
    bundleId: safe.bundleId,
    windowTitle: safe.windowTitle,
    focusedRole: safe.focusedRole,
    safeLabel: safe.safeLabel,
    eventKind: event.kind,
    eventSource: event.source,
    eventContinuous: previous?.name === safe.name && previous?.bundleId === safe.bundleId,
    observerHealthy: options.observerHealthy ?? observer === 'healthy',
    privacyState
  })
  assessments.set(event.id, assessment)
  latestAssessment = assessment
  latestContextKey = contextKey(safe)
  if (assessment.semanticLevel === 'partial') consecutivePartialCount += 1
  else if (assessment.semanticLevel === 'complete') consecutivePartialCount = 0
  else if (privacyState !== 'normal') consecutivePartialCount = 0
  appendEvent(event, nowMs)
  if (!options.suppressed) pendingContextChange = true
  if (
    !options.suppressed &&
    privacyState === 'normal' &&
    assessment.semanticLevel === 'complete' &&
    safe.eventSource === 'accessibility'
  ) {
    semanticWorkClassifier?.({
      eventId: event.id,
      occurredAtMs: nowMs,
      appName: safe.name,
      bundleId: safe.bundleId,
      windowTitle: safe.windowTitle,
      focusedRole: safe.focusedRole ?? '',
      safeLabel: safe.safeLabel ?? '',
      eventKind: event.kind,
      semanticScore: assessment.score,
      source: 'accessibility',
      segmentId: `activity-10m-${utcTenMinuteBucket(nowMs).startIso}`,
      highValueEvent: isHighValueActivityEvent(event)
    })
  }
  return event
}

export function recordScreenChange(context: FrontmostContext, nowMs = Date.now()): void {
  const safe = safeContext({ ...context, eventSource: 'collector' })
  appendEvent(
    {
      id: randomUUID(),
      occurredAtMs: nowMs,
      kind: 'screen_changed',
      source: 'fallback',
      appName: safe.name || null,
      bundleId: safe.bundleId || null,
      windowTitle: safe.windowTitle || null
    },
    nowMs
  )
}

export function recordCollectorEvent(
  event: CollectorEvent,
  privacyForContext: (context: FrontmostContext) => { suppressed: boolean; privacyState: PrivacyState }
): ActivityEvent | null {
  if (event.type === 'heartbeat') {
    markCollectorHealth({
      state: 'healthy',
      restartCount: collectorRestartCount,
      lastHeartbeatAtMs: event.occurredAtMs,
      accessibility: event.accessibility,
      detail: null
    })
    return null
  }
  const context: FrontmostContext = {
    name: event.appName,
    bundleId: event.bundleId,
    windowTitle: event.windowTitle,
    focusedRole: event.focusedRole,
    safeLabel: event.safeLabel,
    eventKind: event.type === 'app_activated' ? 'app_activated' : event.type,
    eventSource: event.accessibility === 'available' ? 'accessibility' : 'collector'
  }
  const privacy = privacyForContext(context)
  return recordFrontmostContext(context, {
    ...privacy,
    observerHealthy: event.accessibility === 'available',
    nowMs: event.occurredAtMs
  })
}

export function startActivityCollector(
  privacyForContext: (context: FrontmostContext) => { suppressed: boolean; privacyState: PrivacyState }
): void {
  stopActivityCollector()
  collectorState = 'starting'
  collectorDetail = null
  collectorRestartCount = 0
  collectorAccessibility = 'unknown'
  void import('./frontapp.ts').then(({ startFrontmostCollector }) => {
    if (collectorState === 'stopped') return
    collectorHandle = startFrontmostCollector(
      (event) => {
        recordCollectorEvent(event, privacyForContext)
      },
      (health) => markCollectorHealth(health)
    )
  }).catch((error) => {
    markCollectorHealth({
      state: 'degraded',
      restartCount: 3,
      lastHeartbeatAtMs: null,
      accessibility: 'unknown',
      detail: error instanceof Error ? error.message : String(error)
    })
  })
}

export function stopActivityCollector(): void {
  collectorHandle?.stop()
  collectorHandle = null
  collectorState = 'stopped'
  collectorDetail = null
}

function markCollectorHealth(health: CollectorHealth): void {
  collectorState = health.state
  collectorDetail = health.detail
  collectorRestartCount = health.restartCount
  collectorAccessibility = health.accessibility
}

export function markActivityObserverFailure(detail: string): void {
  observer = 'unavailable'
  observerDetail = detail.slice(0, 160)
}

export function markActivityObserverHealthy(): void {
  observer = 'healthy'
  observerDetail = null
}

export function activityScanDecision(
  eventDriven: boolean,
  fallbackIntervalSec: number,
  nowMs = Date.now()
): ActivityScanDecision {
  if (!eventDriven) return { run: true, reason: 'interval' }
  if (observer === 'unavailable') return { run: false, reason: 'observer_unavailable' }
  if (observer !== 'healthy') return { run: false, reason: 'waiting' }
  if (pendingContextChange) return { run: true, reason: 'event' }
  if (
    shouldRunHardFallback({
      nowMs,
      startedAtMs,
      lastFallbackAtMs: lastScanAtMs,
      intervalMs: fallbackIntervalSec * 1000
    })
  )
    return { run: true, reason: 'hard_fallback' }
  return { run: false, reason: 'waiting' }
}

export function markActivityScan(reason: ActivityScanReason, nowMs = Date.now()): void {
  lastScanAtMs = nowMs
  lastScanReason = reason
  pendingContextChange = false
}

export function getHybridSemanticState(): {
  assessment: SemanticAssessment
  contextKey: string
  consecutivePartialCount: number
  highValueEvent: boolean
  observerHealthy: boolean
  observerFailureCount: number
  lastOcrAtMs: number | null
  lastOcrContextKey: string | null
} {
  const latest = events.at(-1)
  return {
    assessment: latest ? assessments.get(latest.id) ?? latestAssessment : latestAssessment,
    contextKey: latestContextKey,
    consecutivePartialCount,
    highValueEvent: latest ? isHighValueActivityEvent(latest) : false,
    observerHealthy:
      !latestAssessment.reasonCodes.includes('observer_degraded') &&
      observer === 'healthy' &&
      collectorState !== 'degraded',
    observerFailureCount: collectorRestartCount,
    lastOcrAtMs,
    lastOcrContextKey
  }
}

export function markOcrFallback(reason: OcrTriggerReason, nowMs = Date.now(), context = latestContextKey): void {
  lastOcrAtMs = nowMs
  lastOcrContextKey = context
  ocrFallbackCount += 1
  ocrFallbackReasons[reason] = (ocrFallbackReasons[reason] ?? 0) + 1
  if (reason === 'observer_failure') observerFailureOcrUsed = true
}

export function recordOcrEvidence(
  input: Omit<OcrEvidence, 'id' | 'segmentId'> & { segmentId?: string | null; privacyState?: PrivacyState }
): OcrEvidence | null {
  // This is intentionally a second gate after the caller's frontmost-context check.
  // It prevents a late OCR result from crossing a privacy transition into storage.
  if (input.privacyState && input.privacyState !== 'normal') return null
  const evidence: OcrEvidence = {
    id: randomUUID(),
    eventId: input.eventId,
    segmentId: input.segmentId ?? `activity-10m-${utcTenMinuteBucket(input.occurredAtMs).startIso}`,
    occurredAtMs: input.occurredAtMs,
    appName: input.appName,
    bundleId: input.bundleId,
    windowTitle:
      input.windowTitle == null
        ? null
        : sanitizeWindowTitle(redactSensitive(input.windowTitle).text) || null,
    semanticScore: input.semanticScore,
    triggerReason: input.triggerReason,
    redactionHits: input.redactionHits,
    redactedText: input.redactedText.slice(0, 20_000)
  }
  ocrEvidence = [...ocrEvidence, evidence]
    .filter((item) => item.occurredAtMs >= Date.now() - ACTIVITY_RETENTION_MS)
    .slice(-500)
  persistence?.addOcrEvidence({
    id: evidence.id,
    eventId: evidence.eventId,
    segmentId: evidence.segmentId,
    occurredAt: new Date(evidence.occurredAtMs).toISOString(),
    appName: evidence.appName,
    bundleId: evidence.bundleId,
    windowTitle: evidence.windowTitle,
    semanticScore: evidence.semanticScore,
    triggerReason: evidence.triggerReason,
    redactionHits: evidence.redactionHits,
    redactedText: evidence.redactedText,
    createdAt: new Date(evidence.occurredAtMs).toISOString()
  })
  return evidence
}

export function canUseObserverFailureOcr(): boolean {
  return !observerFailureOcrUsed
}

export function resetActivityGate(nowMs = Date.now()): void {
  startedAtMs = nowMs
  pendingContextChange = false
  observer = 'waiting'
  observerDetail = null
  lastScanAtMs = null
  lastScanReason = null
  lastContext = null
  latestAssessment = { semanticLevel: 'empty', score: 0, reasonCodes: ['no_context'], privacyState: 'normal' }
  latestContextKey = ''
  consecutivePartialCount = 0
  lastOcrAtMs = null
  lastOcrContextKey = null
  observerFailureOcrUsed = false
  workClassificationStatus = 'idle'
  workClassificationSource = null
  workClassificationAtMs = null
  workClassificationDetail = null
  workClassificationCount = 0
}

export function getScreenActivityStatus(input: {
  eventDriven: boolean
  hybridV2: boolean
  running: boolean
  paused: boolean
}): ScreenActivityStatus {
  const nowMs = Date.now()
  events = events.filter((item) => item.occurredAtMs >= nowMs - ACTIVITY_RETENTION_MS)
  const activeIds = new Set(events.map((item) => item.id))
  for (const id of assessments.keys()) if (!activeIds.has(id)) assessments.delete(id)
  ocrEvidence = ocrEvidence.filter((item) => item.occurredAtMs >= nowMs - ACTIVITY_RETENTION_MS)
  const tenMinuteSegments = buildActivitySegments(events, '10m')
  const sixHourSegments = buildActivitySegments(events, '6h')
  persistSegments(tenMinuteSegments, sixHourSegments, nowMs)
  const latestSegment = tenMinuteSegments.at(-1)
  const latestHybrid = latestSegment
    ? hybridSegmentFromActivity(
        latestSegment,
        events
          .filter((event) => event.occurredAtMs >= latestSegment.bucket.startMs && event.occurredAtMs < latestSegment.bucket.endMs)
          .map((event) => assessments.get(event.id))
          .filter((item): item is SemanticAssessment => !!item),
        ocrEvidence.filter(
          (evidence) => evidence.occurredAtMs >= latestSegment.bucket.startMs && evidence.occurredAtMs < latestSegment.bucket.endMs
        )
      )
    : null
  const usable = [...assessments.values()].filter((item) => item.privacyState === 'normal')
  const semanticCoverage = usable.length
    ? Math.round((usable.filter((item) => item.semanticLevel === 'complete').length / usable.length) * 100)
    : 0
  return {
    eventDriven: input.eventDriven,
    hybridV2: input.hybridV2,
    running: input.running,
    paused: input.paused,
    observer,
    observerDetail,
    collector: collectorState,
    collectorDetail,
    collectorRestartCount,
    accessibility: collectorAccessibility,
    semanticCoverage,
    ocrFallbackCount,
    ocrFallbackReasons: { ...ocrFallbackReasons },
    recentTriggerReasons: Object.keys(ocrFallbackReasons).sort(),
    recentSummary: tenMinuteSegments.at(-1)?.summary ?? null,
    latestEventCount: latestHybrid?.eventCount ?? 0,
    latestMeaningfulEventCount: latestHybrid?.meaningfulEventCount ?? 0,
    latestSemanticCompleteCount: latestHybrid?.semanticCompleteCount ?? 0,
    latestSemanticPartialCount: latestHybrid?.semanticPartialCount ?? 0,
    latestSemanticEmptyCount: latestHybrid?.semanticEmptyCount ?? 0,
    latestOcrEvidenceCount: latestHybrid?.ocrEvidenceCount ?? 0,
    lastEventAt: isoOrNull(lastEventAtMs),
    lastScanAt: isoOrNull(lastScanAtMs),
    lastScanReason,
    pendingEvent: pendingContextChange,
    rawEventCount: events.length,
    tenMinuteSegmentCount: tenMinuteSegments.length,
    sixHourSegmentCount: sixHourSegments.length,
    latestSummary: tenMinuteSegments.at(-1)?.summary ?? null,
    workClassificationStatus,
    workClassificationSource,
    workClassificationAt: isoOrNull(workClassificationAtMs),
    workClassificationDetail,
    workClassificationCount
  }
}

function persistSegments(
  tenMinuteSegments: ReturnType<typeof buildActivitySegments>,
  sixHourSegments: ReturnType<typeof buildActivitySegments>,
  nowMs: number
): void {
  if (!persistence) return
  const all = [...tenMinuteSegments, ...sixHourSegments]
  for (const segment of all) {
    const segmentEvents = events.filter(
      (event) => event.occurredAtMs >= segment.bucket.startMs && event.occurredAtMs < segment.bucket.endMs
    )
    const segmentAssessments = segmentEvents
      .map((event) => assessments.get(event.id))
      .filter((item): item is SemanticAssessment => !!item)
    const segmentOcr = ocrEvidence.filter(
      (evidence) => evidence.occurredAtMs >= segment.bucket.startMs && evidence.occurredAtMs < segment.bucket.endMs
    )
    const hybrid = hybridSegmentFromActivity(segment, segmentAssessments, segmentOcr)
    persistence.upsertSegment({
      id: hybrid.id,
      bucketKind: hybrid.bucket.kind,
      bucketStart: hybrid.bucket.startIso,
      bucketEnd: hybrid.bucket.endIso,
      firstEventAt: new Date(hybrid.firstEventAtMs).toISOString(),
      lastEventAt: new Date(hybrid.lastEventAtMs).toISOString(),
      eventCount: hybrid.eventCount,
      meaningfulEventCount: hybrid.meaningfulEventCount,
      semanticCompleteCount: hybrid.semanticCompleteCount,
      semanticPartialCount: hybrid.semanticPartialCount,
      semanticEmptyCount: hybrid.semanticEmptyCount,
      ocrEvidenceCount: hybrid.ocrEvidenceCount,
      triggerReasons: hybrid.triggerReasons,
      summary: hybrid.summary,
      closed: nowMs >= hybrid.bucket.endMs,
      createdAt: new Date(hybrid.firstEventAtMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString()
    })
  }
}
