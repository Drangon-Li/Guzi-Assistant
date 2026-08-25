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
import { emptyHistoryStoreHealth } from '../shared/history.ts'
import type { SemanticWorkEvidence } from '../shared/semantic-work.ts'
import type {
  ActivityHistorySegmentRecord,
  HistoryStoreHealth,
  OcrEvidenceRecord,
  ScreenActivityStatus
} from '../shared/types.ts'
import type {
  CollectorEvent,
  CollectorHealth,
  FrontmostCollectorHandle,
  FrontmostContext
} from './frontapp.ts'
import { CollectorPolicy, type CollectorPolicyMetrics } from './history/collector-policy.ts'
import { isPrivateBrowserWindow } from './history/privacy-policy.ts'

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
let collectorInputMonitoring: ScreenActivityStatus['inputMonitoring'] = 'unknown'
let collectorLastHeartbeatAtMs: number | null = null
let collectorPolicyMetrics: CollectorPolicyMetrics = {
  droppedCount: 0,
  deduplicatedCount: 0,
  rateLimitedCount: 0,
  backoffDroppedCount: 0,
  backoffBundleCount: 0
}
const collectorPolicy = new CollectorPolicy()
let collectorHandle: FrontmostCollectorHandle | null = null
let collectorGeneration = 0
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
  appendHistoryEvent?: (event: ActivityEvent) => void
}

interface CollectorModule {
  startFrontmostCollector: (
    onEvent: (event: CollectorEvent) => void,
    onHealth: (health: CollectorHealth) => void
  ) => FrontmostCollectorHandle
}

type CollectorModuleLoader = () => Promise<CollectorModule>

const defaultCollectorModuleLoader: CollectorModuleLoader = () => import('./frontapp.ts')

function isCurrentCollectorGeneration(generation: number): boolean {
  return generation === collectorGeneration && collectorState !== 'stopped'
}

let persistence: ActivityHistoryPersistence | null = null
let persistedSegmentFingerprints = new Map<string, string>()
let historyHealthProvider: (() => HistoryStoreHealth) | null = null

export function configureActivityHistoryPersistence(next: ActivityHistoryPersistence | null): void {
  if (persistence !== next) persistedSegmentFingerprints.clear()
  persistence = next
}

/** Clear the process-local baseline cache after an external database wipe. */
export function invalidateActivityHistoryPersistenceCache(): void {
  persistedSegmentFingerprints.clear()
}

export function configureHistoryHealthProvider(next: (() => HistoryStoreHealth) | null): void {
  historyHealthProvider = next
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

function readHistoryHealth(): HistoryStoreHealth {
  if (!historyHealthProvider) return emptyHistoryStoreHealth({ enabled: false, state: 'disabled' })
  try {
    return historyHealthProvider()
  } catch (error) {
    return emptyHistoryStoreHealth({
      enabled: true,
      state: 'degraded',
      lastError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
    })
  }
}

function appendEvent(event: ActivityEvent, nowMs: number): void {
  const nextEvents = event.suppressed ? [...events, event] : dedupeActivityEvents([...events, event])
  const accepted = event.suppressed || nextEvents.some((item) => item.id === event.id)
  events = nextEvents
    .filter((item) => item.occurredAtMs >= nowMs - ACTIVITY_RETENTION_MS)
    .slice(-MAX_EVENTS)
  for (const id of assessments.keys()) {
    const assessment = events.some((item) => item.id === id)
    if (!assessment) assessments.delete(id)
  }
  lastEventAtMs = event.occurredAtMs
  if (!accepted) return
  try {
    persistence?.appendHistoryEvent?.(event)
  } catch {
    // A persistence failure must not stop foreground-event collection.
  }
}

function safeContext(context: FrontmostContext): FrontmostContext {
  return {
    name: context.name.trim().slice(0, 80),
    bundleId: context.bundleId.trim().slice(0, 160),
    windowTitle: sanitizeWindowTitle(redactSensitive(context.windowTitle).text),
    urlHost: context.urlHost?.trim().toLowerCase().slice(0, 255),
    windowId:
      context.windowId == null || !Number.isFinite(context.windowId)
        ? undefined
        : Math.max(0, Math.trunc(context.windowId)),
    focusedRole: context.focusedRole?.trim().slice(0, 80),
    focusedSubrole: context.focusedSubrole?.trim().slice(0, 80),
    safeLabel: sanitizeWindowTitle(redactSensitive(context.safeLabel ?? '').text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160),
    targetRole: context.targetRole?.trim().slice(0, 80),
    targetSubrole: context.targetSubrole?.trim().slice(0, 80),
    targetId: context.targetId?.trim().slice(0, 160),
    command: context.command?.trim().slice(0, 80),
    modifiers: context.modifiers?.map((item) => item.trim().slice(0, 24)).filter(Boolean).slice(0, 8),
    inputLength:
      context.inputLength == null || !Number.isFinite(context.inputLength)
        ? null
        : Math.max(0, Math.min(100_000, Math.trunc(context.inputLength))),
    secureInput: context.secureInput === true,
    eventKind: context.eventKind,
    eventSource: context.eventSource
  }
}

export function isPrivateBrowsingContext(context: FrontmostContext): boolean {
  return isPrivateBrowserWindow(context.bundleId, context.windowTitle)
}

export interface RecordContextOptions {
  suppressed: boolean
  privacyState?: PrivacyState
  /** collector 能读到上下文但没有 Accessibility 语义时，仍保留事件并标记为降级。 */
  observerHealthy?: boolean
  nowMs?: number
  eventKind?: FrontmostContext['eventKind']
  eventSource?: FrontmostContext['eventSource']
  forceEvent?: boolean
  targetRole?: string | null
  targetId?: string | null
  command?: string | null
  modifiers?: string[] | null
  inputLength?: number | null
  secureInput?: boolean
}

export function recordFrontmostContext(
  context: FrontmostContext,
  options: RecordContextOptions
): ActivityEvent | null {
  const nowMs = options.nowMs ?? Date.now()
  observer = options.observerHealthy === false ? 'unavailable' : 'healthy'
  observerDetail = options.observerHealthy === false ? 'Accessibility unavailable' : null
  const safe = safeContext({
    ...context,
    eventKind: options.eventKind ?? context.eventKind,
    eventSource: options.eventSource ?? context.eventSource,
    targetRole: options.targetRole ?? context.targetRole,
    targetId: options.targetId ?? context.targetId,
    command: options.command ?? context.command,
    modifiers: options.modifiers ?? context.modifiers,
    inputLength: options.inputLength ?? context.inputLength,
    secureInput: options.secureInput ?? context.secureInput
  })
  const previous = lastContext
  const appChanged = !previous || previous.name !== safe.name || previous.bundleId !== safe.bundleId
  const contextChanged =
    appChanged ||
    !previous ||
    previous.windowTitle !== safe.windowTitle ||
    previous.urlHost !== safe.urlHost ||
    previous.windowId !== safe.windowId ||
    previous.focusedRole !== safe.focusedRole ||
    previous.focusedSubrole !== safe.focusedSubrole ||
    previous.safeLabel !== safe.safeLabel ||
    previous.targetSubrole !== safe.targetSubrole ||
    safe.eventKind === 'ax_focus_changed' ||
    safe.eventKind === 'ax_attribute_changed' ||
    options.forceEvent === true
  lastContext = safe
  if (!contextChanged) return null

  const privacyState = options.privacyState ?? (options.suppressed ? 'excluded' : 'normal')
  const event: ActivityEvent = {
    id: randomUUID(),
    occurredAtMs: nowMs,
    kind: safe.eventKind ?? (appChanged ? 'app_activated' : 'window_changed'),
    source: safe.eventSource === 'accessibility' ? 'accessibility' : safe.eventSource === 'collector' ? 'collector' : 'workspace',
    privacyState,
    ...(options.suppressed
      ? { suppressed: true }
      : {
          appName: safe.name || null,
          bundleId: safe.bundleId || null,
          windowTitle: safe.windowTitle || null,
          urlHost: safe.urlHost || null,
          windowId: safe.windowId ?? null,
          focusedRole: safe.focusedRole || null,
          focusedSubrole: safe.focusedSubrole || null,
          safeLabel: safe.safeLabel || null,
          targetRole: safe.targetRole || safe.focusedRole || null,
          targetSubrole: safe.targetSubrole || safe.focusedSubrole || null,
          targetId: safe.targetId || null,
          command: safe.command || null,
          modifiers: safe.modifiers ?? [],
          inputLength: safe.inputLength ?? null,
          secureInput: safe.secureInput === true
        })
  }
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
      windowTitle: safe.windowTitle || null,
      privacyState: 'normal'
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
      detail: null,
      inputMonitoring: event.inputMonitoring ?? collectorInputMonitoring
    })
    return null
  }
  const context: FrontmostContext = {
    name: event.appName,
    bundleId: event.bundleId,
    windowTitle: event.windowTitle,
    urlHost: event.urlHost,
    windowId: event.windowId,
    focusedRole: event.focusedRole,
    focusedSubrole: event.focusedSubrole,
    safeLabel: event.safeLabel,
    targetRole: event.targetRole,
    targetSubrole: event.targetSubrole,
    targetId: event.targetId,
    command: event.command,
    modifiers: event.modifiers,
    inputLength: event.inputLength,
    secureInput: event.secureInput,
    eventKind: event.type === 'app_activated' ? 'app_activated' : event.type,
    eventSource: event.accessibility === 'available' ? 'accessibility' : 'collector'
  }
  const privacy =
    event.privacyState && event.privacyState !== 'normal'
      ? { suppressed: true, privacyState: event.privacyState as PrivacyState }
      : privacyForContext(context)
  const gateDecision = privacy.suppressed
    ? { accepted: true, reason: 'accepted' as const }
    : collectorPolicy.accept({
        kind: context.eventKind!,
        source: context.eventSource === 'accessibility' ? 'accessibility' : 'collector',
        appName: context.name,
        bundleId: context.bundleId,
        windowTitle: context.windowTitle,
        urlHost: context.urlHost,
        windowId: context.windowId,
        focusedRole: context.focusedRole,
        focusedSubrole: context.focusedSubrole,
        targetRole: context.targetRole,
        targetSubrole: context.targetSubrole,
        safeLabel: context.safeLabel,
        command: context.command,
        modifiers: context.modifiers,
        inputLength: context.inputLength,
        privacyState: privacy.privacyState,
        occurredAtMs: event.occurredAtMs
      }, event.occurredAtMs)
  collectorPolicyMetrics = collectorPolicy.snapshot()
  if (!gateDecision.accepted) return null
  const recorded = recordFrontmostContext(context, {
    ...privacy,
    observerHealthy: event.accessibility === 'available',
    nowMs: event.occurredAtMs,
    forceEvent: true,
    targetRole: event.targetRole,
    targetId: event.targetId,
    command: event.command,
    modifiers: event.modifiers,
    inputLength: event.inputLength,
    secureInput: event.secureInput
  })
  if (event.accessibility === 'unavailable') collectorPolicy.recordBundleFailure(event.bundleId, event.occurredAtMs)
  else collectorPolicy.recordBundleSuccess(event.bundleId)
  collectorPolicyMetrics = collectorPolicy.snapshot()
  return recorded
}

export function startActivityCollector(
  privacyForContext: (context: FrontmostContext) => { suppressed: boolean; privacyState: PrivacyState },
  loadCollectorModule: CollectorModuleLoader = defaultCollectorModuleLoader
): void {
  stopActivityCollector()
  const generation = ++collectorGeneration
  collectorState = 'starting'
  collectorDetail = null
  collectorRestartCount = 0
  collectorAccessibility = 'unknown'
  collectorInputMonitoring = 'unknown'
  collectorLastHeartbeatAtMs = null
  collectorPolicy.reset()
  collectorPolicyMetrics = collectorPolicy.snapshot()
  void loadCollectorModule().then(({ startFrontmostCollector }) => {
    if (!isCurrentCollectorGeneration(generation)) return
    const handle = startFrontmostCollector(
      (event) => {
        if (generation !== collectorGeneration) return
        recordCollectorEvent(event, privacyForContext)
      },
      (health) => {
        if (generation !== collectorGeneration) return
        markCollectorHealth(health)
      }
    )
    if (!isCurrentCollectorGeneration(generation)) {
      handle.stop()
      return
    }
    collectorHandle = handle
  }).catch((error) => {
    if (generation !== collectorGeneration) return
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
  collectorGeneration += 1
  const handle = collectorHandle
  collectorHandle = null
  collectorState = 'stopped'
  collectorDetail = null
  collectorLastHeartbeatAtMs = null
  handle?.stop()
}

function markCollectorHealth(health: CollectorHealth): void {
  collectorState = health.state === 'healthy' && health.accessibility === 'unavailable' ? 'degraded' : health.state
  collectorDetail = health.detail
  collectorRestartCount = health.restartCount
  collectorAccessibility = health.accessibility
  collectorInputMonitoring = health.inputMonitoring ?? collectorInputMonitoring
  collectorLastHeartbeatAtMs = health.lastHeartbeatAtMs
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
      collectorState !== 'degraded' &&
      collectorAccessibility !== 'unavailable',
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
  collectorPolicy.reset()
  collectorPolicyMetrics = collectorPolicy.snapshot()
  persistedSegmentFingerprints.clear()
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
    collectorDroppedEventCount: collectorPolicyMetrics.droppedCount,
    collectorDeduplicatedEventCount: collectorPolicyMetrics.deduplicatedCount,
    collectorRateLimitedCount: collectorPolicyMetrics.rateLimitedCount,
    collectorBackoffBundleCount: collectorPolicyMetrics.backoffBundleCount,
    accessibility: collectorAccessibility,
    inputMonitoring: collectorInputMonitoring,
    lastHeartbeatAt: isoOrNull(collectorLastHeartbeatAtMs),
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
    workClassificationCount,
    history: readHistoryHealth()
  }
}

function persistSegments(
  tenMinuteSegments: ReturnType<typeof buildActivitySegments>,
  sixHourSegments: ReturnType<typeof buildActivitySegments>,
  nowMs: number
): void {
  if (!persistence) return
  const all = [...tenMinuteSegments, ...sixHourSegments]
  const activeIds = new Set(all.map((segment) => segment.id))
  for (const id of persistedSegmentFingerprints.keys()) {
    if (!activeIds.has(id)) persistedSegmentFingerprints.delete(id)
  }
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
    const record: ActivityHistorySegmentRecord = {
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
    }
    const fingerprint = JSON.stringify({ ...record, updatedAt: null })
    if (persistedSegmentFingerprints.get(record.id) === fingerprint) continue
    persistence.upsertSegment(record)
    persistedSegmentFingerprints.set(record.id, fingerprint)
  }
}
