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
  urlHost?: string | null
  eventId: string
  occurredAtMs: number
  eventKind: string
  segmentId: string
  highValueEvent: boolean
}

const MAX_EVENTS = 5000

interface ActivityHistoryPersistence {
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

type PrivacyDecider = (context: FrontmostContext) => { suppressed: boolean; privacyState: PrivacyState }

const isoOrNull = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString()

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

/** 活动事件流的运行态：事件缓冲、语义评估、collector 生命周期与 OCR 门控状态全部收在实例里。 */
class ActivityTracker {
  private events: ActivityEvent[] = []
  private assessments = new Map<string, SemanticAssessment>()
  private startedAtMs = Date.now()
  private lastContext: FrontmostContext | null = null
  private lastCollectorContext: { context: FrontmostContext; at: number; privacy: { suppressed: boolean; privacyState: PrivacyState } } | null = null
  private pendingContextChange = false
  private observer: ScreenActivityStatus['observer'] = 'waiting'
  private observerDetail: string | null = null
  private collectorState: ScreenActivityStatus['collector'] = 'stopped'
  private collectorDetail: string | null = null
  private collectorRestartCount = 0
  private collectorAccessibility: ScreenActivityStatus['accessibility'] = 'unknown'
  private collectorInputMonitoring: ScreenActivityStatus['inputMonitoring'] = 'unknown'
  private collectorInputMonitoringPermission: ScreenActivityStatus['inputMonitoringPermission'] = 'unknown'
  private collectorInputMonitoringListener: ScreenActivityStatus['inputMonitoringListener'] = 'unknown'
  private collectorLastInputEventAtMs: number | null = null
  private collectorLastHeartbeatAtMs: number | null = null
  private readonly collectorPolicy = new CollectorPolicy()
  private collectorPolicyMetrics: CollectorPolicyMetrics = this.collectorPolicy.snapshot()
  private collectorHandle: FrontmostCollectorHandle | null = null
  private collectorGeneration = 0
  private lastEventAtMs: number | null = null
  private lastScanAtMs: number | null = null
  private lastScanReason: ActivityScanReason | null = null
  private latestAssessment: SemanticAssessment = {
    semanticLevel: 'empty',
    score: 0,
    reasonCodes: ['no_context'],
    privacyState: 'normal'
  }
  private latestContextKey = ''
  private consecutivePartialCount = 0
  private ocrFallbackCount = 0
  private ocrFallbackReasons: Record<string, number> = {}
  private lastOcrAtMs: number | null = null
  private lastOcrContextKey: string | null = null
  private observerFailureOcrUsed = false
  private ocrEvidence: OcrEvidence[] = []
  private semanticWorkClassifier: ((context: AccessibilityWorkContext) => void) | null = null
  private workClassificationStatus: ScreenActivityStatus['workClassificationStatus'] = 'idle'
  private workClassificationSource: ScreenActivityStatus['workClassificationSource'] = null
  private workClassificationAtMs: number | null = null
  private workClassificationDetail: string | null = null
  private workClassificationCount = 0
  private persistence: ActivityHistoryPersistence | null = null
  private historyHealthProvider: (() => HistoryStoreHealth) | null = null

  configurePersistence(next: ActivityHistoryPersistence | null): void {
    this.persistence = next
  }

  configureHistoryHealthProvider(next: (() => HistoryStoreHealth) | null): void {
    this.historyHealthProvider = next
  }

  configureSemanticWorkClassifier(next: ((context: AccessibilityWorkContext) => void) | null): void {
    this.semanticWorkClassifier = next
  }

  setWorkClassificationStatus(input: {
    status: ScreenActivityStatus['workClassificationStatus']
    source?: ScreenActivityStatus['workClassificationSource']
    detail?: string | null
    atMs?: number | null
    increment?: boolean
  }): void {
    this.workClassificationStatus = input.status
    if (input.source !== undefined) this.workClassificationSource = input.source
    if (input.detail !== undefined) this.workClassificationDetail = input.detail
    if (input.atMs !== undefined) this.workClassificationAtMs = input.atMs
    if (input.increment) this.workClassificationCount += 1
  }

  private readHistoryHealth(): HistoryStoreHealth {
    if (!this.historyHealthProvider) return emptyHistoryStoreHealth({ enabled: false, state: 'disabled' })
    try {
      return this.historyHealthProvider()
    } catch (error) {
      return emptyHistoryStoreHealth({
        enabled: true,
        state: 'degraded',
        lastError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
      })
    }
  }

  private appendEvent(event: ActivityEvent, nowMs: number): void {
    const nextEvents = event.suppressed ? [...this.events, event] : dedupeActivityEvents([...this.events, event])
    const accepted = event.suppressed || nextEvents.some((item) => item.id === event.id)
    this.events = nextEvents
      .filter((item) => item.occurredAtMs >= nowMs - ACTIVITY_RETENTION_MS)
      .slice(-MAX_EVENTS)
    for (const id of this.assessments.keys()) {
      const assessment = this.events.some((item) => item.id === id)
      if (!assessment) this.assessments.delete(id)
    }
    this.lastEventAtMs = event.occurredAtMs
    if (!accepted) return
    try {
      this.persistence?.appendHistoryEvent?.(event)
    } catch {
      // A persistence failure must not stop foreground-event collection.
    }
  }

  recordFrontmostContext(context: FrontmostContext, options: RecordContextOptions): ActivityEvent | null {
    const nowMs = options.nowMs ?? Date.now()
    // 只有显式声明健康态的来源（collector 事件带 accessibility 状态）才更新 observer；
    // 轮询路径（watchTick/sampleTick）不传，避免与 collector 竞写导致健康态来回抖动。
    if (options.observerHealthy !== undefined) {
      this.observer = options.observerHealthy === false ? 'unavailable' : 'healthy'
      this.observerDetail = options.observerHealthy === false ? 'Accessibility unavailable' : null
    }
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
    const previous = this.lastContext
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
    this.lastContext = safe
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
      observerHealthy: options.observerHealthy ?? this.observer === 'healthy',
      privacyState
    })
    this.assessments.set(event.id, assessment)
    this.latestAssessment = assessment
    this.latestContextKey = contextKey(safe)
    if (assessment.semanticLevel === 'partial') this.consecutivePartialCount += 1
    else if (assessment.semanticLevel === 'complete') this.consecutivePartialCount = 0
    else if (privacyState !== 'normal') this.consecutivePartialCount = 0
    this.appendEvent(event, nowMs)
    if (!options.suppressed) this.pendingContextChange = true
    if (
      !options.suppressed &&
      privacyState === 'normal' &&
      assessment.semanticLevel === 'complete' &&
      safe.eventSource === 'accessibility'
    ) {
      this.semanticWorkClassifier?.({
        eventId: event.id,
        occurredAtMs: nowMs,
        appName: safe.name,
        bundleId: safe.bundleId,
        urlHost: safe.urlHost,
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

  recordScreenChange(context: FrontmostContext, nowMs = Date.now()): void {
    const safe = safeContext({ ...context, eventSource: 'collector' })
    this.appendEvent(
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

  recordCollectorEvent(event: CollectorEvent, privacyForContext: PrivacyDecider): ActivityEvent | null {
    if (event.type === 'heartbeat') {
      this.markCollectorHealth({
        state: 'healthy',
        restartCount: this.collectorRestartCount,
        lastHeartbeatAtMs: event.occurredAtMs,
        accessibility: event.accessibility,
        detail: null,
        inputMonitoring: event.inputMonitoring,
        inputMonitoringPermission: event.inputMonitoringPermission,
        inputMonitoringListener: event.inputMonitoringListener,
        lastInputEventAtMs: event.lastInputEventAtMs
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
    if (event.secureInput === true || privacy.suppressed ||
      (event.secureInput === false && event.accessibility === 'available' && !!context.focusedRole))
      this.lastCollectorContext = { context, at: event.occurredAtMs, privacy }
    const gateDecision = privacy.suppressed
      ? { accepted: true, reason: 'accepted' as const }
      : this.collectorPolicy.accept({
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
    this.collectorPolicyMetrics = this.collectorPolicy.snapshot()
    if (!gateDecision.accepted) return null
    const recorded = this.recordFrontmostContext(context, {
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
    if (event.accessibility === 'unavailable') this.collectorPolicy.recordBundleFailure(event.bundleId, event.occurredAtMs)
    else this.collectorPolicy.recordBundleSuccess(event.bundleId)
    this.collectorPolicyMetrics = this.collectorPolicy.snapshot()
    return recorded
  }

  collectorCaptureSafety(context: { bundleId: string; windowId?: number | null }, nowMs = Date.now()): {
    blocked: boolean; reason: string | null; urlHost: string | null
  } {
    const last = this.lastCollectorContext
    if (!last || nowMs < last.at || nowMs - last.at > 10_000 || last.context.bundleId !== context.bundleId ||
      (last.context.windowId != null && context.windowId != null && last.context.windowId !== context.windowId))
      return { blocked: false, reason: null, urlHost: null }
    const secure = last.context.secureInput || /secure|password|secret/i.test(
      `${last.context.focusedRole ?? ''} ${last.context.focusedSubrole ?? ''} ${last.context.targetSubrole ?? ''}`)
    const blocked = !!secure || last.privacy.suppressed
    return { blocked, reason: secure ? 'secure_input' : blocked ? last.privacy.privacyState : null, urlHost: last.context.urlHost ?? null }
  }

  private isCurrentCollectorGeneration(generation: number): boolean {
    return generation === this.collectorGeneration && this.collectorState !== 'stopped'
  }

  startCollector(privacyForContext: PrivacyDecider, loadCollectorModule: CollectorModuleLoader = defaultCollectorModuleLoader): void {
    this.stopCollector()
    const generation = ++this.collectorGeneration
    this.collectorState = 'starting'
    this.collectorDetail = null
    this.collectorRestartCount = 0
    this.collectorAccessibility = 'unknown'
    this.collectorInputMonitoring = 'unknown'
    this.collectorInputMonitoringPermission = 'unknown'
    this.collectorInputMonitoringListener = 'unknown'
    this.collectorLastInputEventAtMs = null
    this.collectorLastHeartbeatAtMs = null
    this.collectorPolicy.reset()
    this.collectorPolicyMetrics = this.collectorPolicy.snapshot()
    void loadCollectorModule().then(({ startFrontmostCollector }) => {
      if (!this.isCurrentCollectorGeneration(generation)) return
      const handle = startFrontmostCollector(
        (event) => {
          if (generation !== this.collectorGeneration) return
          this.recordCollectorEvent(event, privacyForContext)
        },
        (health) => {
          if (generation !== this.collectorGeneration) return
          this.markCollectorHealth(health)
        }
      )
      if (!this.isCurrentCollectorGeneration(generation)) {
        handle.stop()
        return
      }
      this.collectorHandle = handle
    }).catch((error) => {
      if (generation !== this.collectorGeneration) return
      this.markCollectorHealth({
        state: 'degraded',
        restartCount: 3,
        lastHeartbeatAtMs: null,
        accessibility: 'unknown',
        detail: error instanceof Error ? error.message : String(error)
      })
    })
  }

  stopCollector(): void {
    this.collectorGeneration += 1
    const handle = this.collectorHandle
    this.collectorHandle = null
    this.collectorState = 'stopped'
    this.collectorDetail = null
    this.collectorInputMonitoring = 'unknown'
    this.collectorInputMonitoringListener = 'inactive'
    this.collectorLastHeartbeatAtMs = null
    handle?.stop()
  }

  private markCollectorHealth(health: CollectorHealth): void {
    this.collectorRestartCount = health.restartCount
    this.collectorAccessibility = health.accessibility
    this.collectorInputMonitoring = health.inputMonitoring ?? this.collectorInputMonitoring
    this.collectorInputMonitoringPermission = health.inputMonitoringPermission ?? this.collectorInputMonitoringPermission
    this.collectorInputMonitoringListener = health.inputMonitoringListener ?? this.collectorInputMonitoringListener
    if (health.lastInputEventAtMs !== undefined) this.collectorLastInputEventAtMs = health.lastInputEventAtMs
    this.collectorLastHeartbeatAtMs = health.lastHeartbeatAtMs
    const unavailableDetail = health.accessibility === 'unavailable' ? 'Accessibility unavailable'
      : this.collectorInputMonitoringPermission === 'unavailable' ? 'Input Monitoring permission unavailable'
        : this.collectorInputMonitoringListener === 'inactive' ? 'Input listener unavailable' : null
    this.collectorState = health.state === 'healthy' && unavailableDetail ? 'degraded' : health.state
    this.collectorDetail = health.detail ?? (health.state === 'healthy' ? unavailableDetail : null)
  }

  markObserverFailure(detail: string): void {
    this.observer = 'unavailable'
    this.observerDetail = detail.slice(0, 160)
  }

  markObserverHealthy(): void {
    this.observer = 'healthy'
    this.observerDetail = null
  }

  scanDecision(eventDriven: boolean, fallbackIntervalSec: number, nowMs = Date.now()): ActivityScanDecision {
    if (!eventDriven) return { run: true, reason: 'interval' }
    if (this.observer === 'unavailable') return { run: false, reason: 'observer_unavailable' }
    if (this.observer !== 'healthy') return { run: false, reason: 'waiting' }
    if (this.pendingContextChange) return { run: true, reason: 'event' }
    if (
      shouldRunHardFallback({
        nowMs,
        startedAtMs: this.startedAtMs,
        lastFallbackAtMs: this.lastScanAtMs,
        intervalMs: fallbackIntervalSec * 1000
      })
    )
      return { run: true, reason: 'hard_fallback' }
    return { run: false, reason: 'waiting' }
  }

  markScan(reason: ActivityScanReason, nowMs = Date.now()): void {
    this.lastScanAtMs = nowMs
    this.lastScanReason = reason
    this.pendingContextChange = false
  }

  hybridSemanticState(): {
    assessment: SemanticAssessment
    contextKey: string
    consecutivePartialCount: number
    highValueEvent: boolean
    observerHealthy: boolean
    observerFailureCount: number
    lastOcrAtMs: number | null
    lastOcrContextKey: string | null
  } {
    const latest = this.events.at(-1)
    return {
      assessment: latest ? this.assessments.get(latest.id) ?? this.latestAssessment : this.latestAssessment,
      contextKey: this.latestContextKey,
      consecutivePartialCount: this.consecutivePartialCount,
      highValueEvent: latest ? isHighValueActivityEvent(latest) : false,
      observerHealthy:
        !this.latestAssessment.reasonCodes.includes('observer_degraded') &&
        this.observer === 'healthy' &&
        this.collectorState !== 'degraded' &&
        this.collectorAccessibility !== 'unavailable',
      observerFailureCount: this.collectorRestartCount,
      lastOcrAtMs: this.lastOcrAtMs,
      lastOcrContextKey: this.lastOcrContextKey
    }
  }

  markOcrFallback(reason: OcrTriggerReason, nowMs = Date.now(), context = this.latestContextKey): void {
    this.lastOcrAtMs = nowMs
    this.lastOcrContextKey = context
    this.ocrFallbackCount += 1
    this.ocrFallbackReasons[reason] = (this.ocrFallbackReasons[reason] ?? 0) + 1
    if (reason === 'observer_failure') this.observerFailureOcrUsed = true
  }

  recordOcrEvidence(
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
      windowId: input.windowId,
      urlHost: input.urlHost,
      windowTitle:
        input.windowTitle == null
          ? null
          : sanitizeWindowTitle(redactSensitive(input.windowTitle).text) || null,
      semanticScore: input.semanticScore,
      triggerReason: input.triggerReason,
      redactionHits: input.redactionHits,
      redactedText: input.redactedText.slice(0, 20_000)
    }
    this.ocrEvidence = [...this.ocrEvidence, evidence]
      .filter((item) => item.occurredAtMs >= Date.now() - ACTIVITY_RETENTION_MS)
      .slice(-500)
    this.persistence?.addOcrEvidence({
      id: evidence.id,
      eventId: evidence.eventId,
      segmentId: evidence.segmentId,
      occurredAt: new Date(evidence.occurredAtMs).toISOString(),
      appName: evidence.appName,
      bundleId: evidence.bundleId,
      windowId: evidence.windowId,
      urlHost: evidence.urlHost,
      windowTitle: evidence.windowTitle,
      semanticScore: evidence.semanticScore,
      triggerReason: evidence.triggerReason,
      redactionHits: evidence.redactionHits,
      redactedText: evidence.redactedText,
      createdAt: new Date(evidence.occurredAtMs).toISOString()
    })
    return evidence
  }

  canUseObserverFailureOcr(): boolean {
    return !this.observerFailureOcrUsed
  }

  clearHistoryEvidence(fromMs = -Infinity, toMs = Infinity): void {
    const outside = (at: number): boolean => at < fromMs || at >= toMs
    this.events = this.events.filter((event) => outside(event.occurredAtMs))
    const ids = new Set(this.events.map((event) => event.id))
    for (const id of this.assessments.keys()) if (!ids.has(id)) this.assessments.delete(id)
    this.ocrEvidence = this.ocrEvidence.filter((evidence) => outside(evidence.occurredAtMs))
    if (this.lastCollectorContext && !outside(this.lastCollectorContext.at)) {
      this.lastCollectorContext.context = { ...this.lastCollectorContext.context, windowTitle: '', safeLabel: '', urlHost: undefined }
    }
    this.lastEventAtMs = this.events.at(-1)?.occurredAtMs ?? null
    this.resetGate()
  }

  resetGate(nowMs = Date.now()): void {
    this.startedAtMs = nowMs
    this.pendingContextChange = false
    this.observer = 'waiting'
    this.observerDetail = null
    this.lastScanAtMs = null
    this.lastScanReason = null
    this.lastContext = null
    this.latestAssessment = { semanticLevel: 'empty', score: 0, reasonCodes: ['no_context'], privacyState: 'normal' }
    this.latestContextKey = ''
    this.consecutivePartialCount = 0
    this.lastOcrAtMs = null
    this.lastOcrContextKey = null
    this.collectorPolicy.reset()
    this.collectorPolicyMetrics = this.collectorPolicy.snapshot()
    this.observerFailureOcrUsed = false
    this.workClassificationStatus = 'idle'
    this.workClassificationSource = null
    this.workClassificationAtMs = null
    this.workClassificationDetail = null
    this.workClassificationCount = 0
  }

  status(input: { eventDriven: boolean; hybridV2: boolean; running: boolean; paused: boolean }): ScreenActivityStatus {
    const nowMs = Date.now()
    this.events = this.events.filter((item) => item.occurredAtMs >= nowMs - ACTIVITY_RETENTION_MS)
    const activeIds = new Set(this.events.map((item) => item.id))
    for (const id of this.assessments.keys()) if (!activeIds.has(id)) this.assessments.delete(id)
    this.ocrEvidence = this.ocrEvidence.filter((item) => item.occurredAtMs >= nowMs - ACTIVITY_RETENTION_MS)
    const tenMinuteSegments = buildActivitySegments(this.events, '10m')
    const sixHourSegments = buildActivitySegments(this.events, '6h')
    const latestSegment = tenMinuteSegments.at(-1)
    const latestHybrid = latestSegment
      ? hybridSegmentFromActivity(
          latestSegment,
          this.events
            .filter((event) => event.occurredAtMs >= latestSegment.bucket.startMs && event.occurredAtMs < latestSegment.bucket.endMs)
            .map((event) => this.assessments.get(event.id))
            .filter((item): item is SemanticAssessment => !!item),
          this.ocrEvidence.filter(
            (evidence) => evidence.occurredAtMs >= latestSegment.bucket.startMs && evidence.occurredAtMs < latestSegment.bucket.endMs
          )
        )
      : null
    const usable = [...this.assessments.values()].filter((item) => item.privacyState === 'normal')
    const semanticCoverage = usable.length
      ? Math.round((usable.filter((item) => item.semanticLevel === 'complete').length / usable.length) * 100)
      : 0
    return {
      eventDriven: input.eventDriven,
      hybridV2: input.hybridV2,
      running: input.running,
      paused: input.paused,
      observer: this.observer,
      observerDetail: this.observerDetail,
      collector: this.collectorState,
      collectorDetail: this.collectorDetail,
      collectorRestartCount: this.collectorRestartCount,
      collectorDroppedEventCount: this.collectorPolicyMetrics.droppedCount,
      collectorDeduplicatedEventCount: this.collectorPolicyMetrics.deduplicatedCount,
      collectorRateLimitedCount: this.collectorPolicyMetrics.rateLimitedCount,
      collectorBackoffBundleCount: this.collectorPolicyMetrics.backoffBundleCount,
      accessibility: this.collectorAccessibility,
      inputMonitoring: this.collectorInputMonitoring,
      inputMonitoringPermission: this.collectorInputMonitoringPermission,
      inputMonitoringListener: this.collectorInputMonitoringListener,
      lastInputEventAt: isoOrNull(this.collectorLastInputEventAtMs),
      lastHeartbeatAt: isoOrNull(this.collectorLastHeartbeatAtMs),
      semanticCoverage,
      ocrFallbackCount: this.ocrFallbackCount,
      ocrFallbackReasons: { ...this.ocrFallbackReasons },
      recentTriggerReasons: Object.keys(this.ocrFallbackReasons).sort(),
      recentSummary: tenMinuteSegments.at(-1)?.summary ?? null,
      latestEventCount: latestHybrid?.eventCount ?? 0,
      latestMeaningfulEventCount: latestHybrid?.meaningfulEventCount ?? 0,
      latestSemanticCompleteCount: latestHybrid?.semanticCompleteCount ?? 0,
      latestSemanticPartialCount: latestHybrid?.semanticPartialCount ?? 0,
      latestSemanticEmptyCount: latestHybrid?.semanticEmptyCount ?? 0,
      latestOcrEvidenceCount: latestHybrid?.ocrEvidenceCount ?? 0,
      lastEventAt: isoOrNull(this.lastEventAtMs),
      lastScanAt: isoOrNull(this.lastScanAtMs),
      lastScanReason: this.lastScanReason,
      pendingEvent: this.pendingContextChange,
      rawEventCount: this.events.length,
      tenMinuteSegmentCount: tenMinuteSegments.length,
      sixHourSegmentCount: sixHourSegments.length,
      latestSummary: tenMinuteSegments.at(-1)?.summary ?? null,
      workClassificationStatus: this.workClassificationStatus,
      workClassificationSource: this.workClassificationSource,
      workClassificationAt: isoOrNull(this.workClassificationAtMs),
      workClassificationDetail: this.workClassificationDetail,
      workClassificationCount: this.workClassificationCount,
      history: this.readHistoryHealth()
    }
  }
}

// 进程内单例 + 薄代理导出：调用方与测试保持原函数 API，不感知类化。
export const activityTracker = new ActivityTracker()

export function configureActivityHistoryPersistence(next: ActivityHistoryPersistence | null): void {
  activityTracker.configurePersistence(next)
}

export function configureHistoryHealthProvider(next: (() => HistoryStoreHealth) | null): void {
  activityTracker.configureHistoryHealthProvider(next)
}

export function configureSemanticWorkClassifier(
  next: ((context: AccessibilityWorkContext) => void) | null
): void {
  activityTracker.configureSemanticWorkClassifier(next)
}

export function setWorkClassificationStatus(input: Parameters<ActivityTracker['setWorkClassificationStatus']>[0]): void {
  activityTracker.setWorkClassificationStatus(input)
}

export function recordFrontmostContext(context: FrontmostContext, options: RecordContextOptions): ActivityEvent | null {
  return activityTracker.recordFrontmostContext(context, options)
}

export function recordScreenChange(context: FrontmostContext, nowMs = Date.now()): void {
  activityTracker.recordScreenChange(context, nowMs)
}

export function recordCollectorEvent(event: CollectorEvent, privacyForContext: PrivacyDecider): ActivityEvent | null {
  return activityTracker.recordCollectorEvent(event, privacyForContext)
}

export function startActivityCollector(
  privacyForContext: PrivacyDecider,
  loadCollectorModule: CollectorModuleLoader = defaultCollectorModuleLoader
): void {
  activityTracker.startCollector(privacyForContext, loadCollectorModule)
}

export function stopActivityCollector(): void {
  activityTracker.stopCollector()
}

export function markActivityObserverFailure(detail: string): void {
  activityTracker.markObserverFailure(detail)
}

export function markActivityObserverHealthy(): void {
  activityTracker.markObserverHealthy()
}

export function activityScanDecision(
  eventDriven: boolean,
  fallbackIntervalSec: number,
  nowMs = Date.now()
): ActivityScanDecision {
  return activityTracker.scanDecision(eventDriven, fallbackIntervalSec, nowMs)
}

export function markActivityScan(reason: ActivityScanReason, nowMs = Date.now()): void {
  activityTracker.markScan(reason, nowMs)
}

export function getHybridSemanticState(): ReturnType<ActivityTracker['hybridSemanticState']> {
  return activityTracker.hybridSemanticState()
}

export function getCollectorCaptureSafety(context: { bundleId: string; windowId?: number | null }, nowMs = Date.now()) {
  return activityTracker.collectorCaptureSafety(context, nowMs)
}

export function clearActivityHistoryEvidence(fromMs?: number, toMs?: number): void {
  activityTracker.clearHistoryEvidence(fromMs, toMs)
}

export function markOcrFallback(reason: OcrTriggerReason, nowMs?: number, context?: string): void {
  if (context === undefined) activityTracker.markOcrFallback(reason, nowMs)
  else activityTracker.markOcrFallback(reason, nowMs, context)
}

export function recordOcrEvidence(
  input: Omit<OcrEvidence, 'id' | 'segmentId'> & { segmentId?: string | null; privacyState?: PrivacyState }
): OcrEvidence | null {
  return activityTracker.recordOcrEvidence(input)
}

export function canUseObserverFailureOcr(): boolean {
  return activityTracker.canUseObserverFailureOcr()
}

export function resetActivityGate(nowMs = Date.now()): void {
  activityTracker.resetGate(nowMs)
}

export function getScreenActivityStatus(input: {
  eventDriven: boolean
  hybridV2: boolean
  running: boolean
  paused: boolean
}): ScreenActivityStatus {
  return activityTracker.status(input)
}
