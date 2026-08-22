import type {
  ActivityEventKind,
  ActivityEventSource,
  ActivityPrivacyState
} from '../../shared/activity-events.ts'

export interface CollectorPolicyEvent {
  kind: ActivityEventKind
  source?: ActivityEventSource
  appName?: string | null
  bundleId?: string | null
  windowTitle?: string | null
  urlHost?: string | null
  windowId?: number | null
  focusedRole?: string | null
  focusedSubrole?: string | null
  targetRole?: string | null
  targetSubrole?: string | null
  safeLabel?: string | null
  command?: string | null
  modifiers?: readonly string[] | null
  inputLength?: number | null
  privacyState?: ActivityPrivacyState | null
  suppressed?: boolean
  occurredAtMs: number
}

export type CollectorDropReason = 'duplicate' | 'rate_limited' | 'backoff'

export interface CollectorPolicyDecision {
  accepted: boolean
  reason: 'accepted' | CollectorDropReason
}

export interface CollectorPolicyMetrics {
  droppedCount: number
  deduplicatedCount: number
  rateLimitedCount: number
  backoffDroppedCount: number
  backoffBundleCount: number
}

export interface CollectorPolicyOptions {
  now?: () => number
  dedupeWindowMs?: number
  maxEventsPerSecond?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
}

interface BundleBackoff {
  failures: number
  untilMs: number
}

const DEFAULT_DEDUPE_WINDOW_MS = 750
const DEFAULT_MAX_EVENTS_PER_SECOND = 120
const DEFAULT_BACKOFF_BASE_MS = 1_000
const DEFAULT_BACKOFF_MAX_MS = 60_000
const RATE_WINDOW_MS = 1_000

function normalized(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function bundleKey(event: Pick<CollectorPolicyEvent, 'bundleId'>): string {
  return normalized(event.bundleId) || '<unknown>'
}

/** Stable signature intentionally excludes event id and timestamp. */
export function collectorEventSignature(event: CollectorPolicyEvent): string {
  return JSON.stringify([
    event.kind,
    normalized(event.appName),
    normalized(event.bundleId),
    normalized(event.windowTitle),
    normalized(event.urlHost),
    Number.isFinite(event.windowId) ? String(Math.trunc(event.windowId!)) : null,
    normalized(event.focusedRole),
    normalized(event.focusedSubrole),
    normalized(event.targetRole),
    normalized(event.safeLabel),
    normalized(event.targetSubrole),
    normalized(event.command),
    [...(event.modifiers ?? [])].map(normalized).sort(),
    Number.isFinite(event.inputLength) ? Math.max(0, Math.trunc(event.inputLength!)) : null,
    event.privacyState ?? 'normal',
    event.suppressed === true
  ])
}

/**
 * Main-process event gate. Suppressed events bypass dedupe/rate limits so a
 * privacy transition is represented by a suppressed counter rather than a
 * silently discarded normal event.
 */
export class CollectorPolicy {
  private readonly now: () => number
  private readonly dedupeWindowMs: number
  private readonly maxEventsPerSecond: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly recent = new Map<string, number>()
  private readonly rateWindows = new Map<string, { startMs: number; count: number }>()
  private readonly backoffs = new Map<string, BundleBackoff>()
  private metrics: CollectorPolicyMetrics = {
    droppedCount: 0,
    deduplicatedCount: 0,
    rateLimitedCount: 0,
    backoffDroppedCount: 0,
    backoffBundleCount: 0
  }

  constructor(options: CollectorPolicyOptions = {}) {
    this.now = options.now ?? Date.now
    this.dedupeWindowMs = Number.isFinite(options.dedupeWindowMs) && (options.dedupeWindowMs ?? 0) >= 0
      ? Math.trunc(options.dedupeWindowMs!)
      : DEFAULT_DEDUPE_WINDOW_MS
    this.maxEventsPerSecond = Number.isFinite(options.maxEventsPerSecond) && (options.maxEventsPerSecond ?? 0) > 0
      ? Math.trunc(options.maxEventsPerSecond!)
      : DEFAULT_MAX_EVENTS_PER_SECOND
    this.backoffBaseMs = Number.isFinite(options.backoffBaseMs) && (options.backoffBaseMs ?? 0) > 0
      ? Math.trunc(options.backoffBaseMs!)
      : DEFAULT_BACKOFF_BASE_MS
    this.backoffMaxMs = Number.isFinite(options.backoffMaxMs) && (options.backoffMaxMs ?? 0) > 0
      ? Math.max(this.backoffBaseMs, Math.trunc(options.backoffMaxMs!))
      : DEFAULT_BACKOFF_MAX_MS
  }

  accept(event: CollectorPolicyEvent, nowMs = this.now()): CollectorPolicyDecision {
    const bundle = bundleKey(event)
    this.prune(nowMs)
    if (event.suppressed || event.privacyState != null && event.privacyState !== 'normal')
      return { accepted: true, reason: 'accepted' }

    const backoff = this.backoffs.get(bundle)
    if (backoff && backoff.untilMs > nowMs) {
      this.metrics.droppedCount += 1
      this.metrics.backoffDroppedCount += 1
      return { accepted: false, reason: 'backoff' }
    }

    const signature = collectorEventSignature(event)
    const previousAtMs = this.recent.get(signature)
    if (previousAtMs != null && nowMs - previousAtMs <= this.dedupeWindowMs) {
      this.metrics.droppedCount += 1
      this.metrics.deduplicatedCount += 1
      return { accepted: false, reason: 'duplicate' }
    }

    const window = this.rateWindows.get(bundle)
    if (window && nowMs - window.startMs < RATE_WINDOW_MS) {
      if (window.count >= this.maxEventsPerSecond) {
        this.metrics.droppedCount += 1
        this.metrics.rateLimitedCount += 1
        return { accepted: false, reason: 'rate_limited' }
      }
      window.count += 1
    } else {
      this.rateWindows.set(bundle, { startMs: nowMs, count: 1 })
    }

    this.recent.set(signature, nowMs)
    return { accepted: true, reason: 'accepted' }
  }

  recordBundleFailure(bundleId: string | null | undefined, nowMs = this.now()): void {
    const bundle = normalized(bundleId) || '<unknown>'
    const previous = this.backoffs.get(bundle)
    const failures = (previous?.failures ?? 0) + 1
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(failures - 1, 12))
    this.backoffs.set(bundle, { failures, untilMs: nowMs + delay })
  }

  recordBundleSuccess(bundleId: string | null | undefined): void {
    this.backoffs.delete(normalized(bundleId) || '<unknown>')
  }

  isBundleBackedOff(bundleId: string | null | undefined, nowMs = this.now()): boolean {
    const backoff = this.backoffs.get(normalized(bundleId) || '<unknown>')
    return !!backoff && backoff.untilMs > nowMs
  }

  snapshot(): CollectorPolicyMetrics {
    return { ...this.metrics, backoffBundleCount: this.backoffs.size }
  }

  reset(): void {
    this.recent.clear()
    this.rateWindows.clear()
    this.backoffs.clear()
    this.metrics = {
      droppedCount: 0,
      deduplicatedCount: 0,
      rateLimitedCount: 0,
      backoffDroppedCount: 0,
      backoffBundleCount: 0
    }
  }

  private prune(nowMs: number): void {
    for (const [signature, timestamp] of this.recent) {
      if (nowMs - timestamp > this.dedupeWindowMs) this.recent.delete(signature)
    }
    for (const [bundle, window] of this.rateWindows) {
      if (nowMs - window.startMs >= RATE_WINDOW_MS) this.rateWindows.delete(bundle)
    }
    for (const [bundle, backoff] of this.backoffs) {
      if (backoff.untilMs <= nowMs) this.backoffs.delete(bundle)
    }
  }
}
