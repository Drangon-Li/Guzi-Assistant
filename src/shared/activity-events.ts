export const TEN_MINUTES_MS = 10 * 60 * 1000
export const SIX_HOURS_MS = 6 * 60 * 60 * 1000
export const ACTIVITY_RETENTION_MS = 48 * 60 * 60 * 1000
export const ACTIVITY_DEDUPE_WINDOW_MS = 750
export const HARD_FALLBACK_MIN_INTERVAL_MS = 30 * 1000
export const HARD_FALLBACK_MAX_INTERVAL_MS = 60 * 1000
export const HARD_FALLBACK_DEFAULT_INTERVAL_MS = 45 * 1000

const HTTP_URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi
const LOOPBACK_CALLBACK_RE =
  /(?<![A-Za-z0-9_.-])(?:localhost|127\.0\.0\.1|\[::1\])(?:(?::\d{1,5})[^\s<>"'`]*|\/[^\s<>"'`]*)/gi
const QUERY_PARAMS_RE = /\?(?:[A-Za-z0-9_.~%-]+=[^\s&#]*)(?:&(?:amp;)?[A-Za-z0-9_.~%-]+=[^\s&#]*)*/gi
const TRAILING_URL_PUNCTUATION_RE = /[\])}>，。；、！]+$/

export type ActivityEventKind =
  | 'app_activated'
  | 'window_changed'
  | 'click'
  | 'right_click'
  | 'drag'
  | 'shortcut'
  | 'submit'
  | 'selection_changed'
  | 'input_activity'
  | 'ax_focus_changed'
  | 'ax_attribute_changed'
  | 'screen_changed'
  | 'idle_started'
  | 'idle_ended'

export type ActivityEventSource = 'accessibility' | 'workspace' | 'fallback' | 'collector'

/** Privacy decision attached before an event can cross a persistence boundary. */
export type ActivityPrivacyState = 'normal' | 'private' | 'excluded' | 'own' | 'secure'

/**
 * Privacy-minimized activity metadata. Raw typed text, selected text, AX text,
 * and full URLs are intentionally absent from this type. Window and target
 * identifiers still require retention and exclusion controls at the caller.
 */
export interface ActivityEvent {
  id: string
  occurredAtMs: number
  kind: ActivityEventKind
  source: ActivityEventSource
  appName?: string | null
  bundleId?: string | null
  windowTitle?: string | null
  urlHost?: string | null
  /** WindowServer identity used only to distinguish same-title windows in memory. */
  windowId?: number | null
  targetRole?: string | null
  targetId?: string | null
  /** Shallow AX metadata only; never a raw value or selected text. */
  focusedRole?: string | null
  focusedSubrole?: string | null
  targetSubrole?: string | null
  safeLabel?: string | null
  /** Semantic command or shortcut only, never a printable key stream. */
  command?: string | null
  modifiers?: string[]
  inputLength?: number | null
  secureInput?: boolean
  suppressed?: boolean
  privacyState?: ActivityPrivacyState
}

export type ActivityBucketKind = '10m' | '6h'

export interface ActivityBucket {
  kind: ActivityBucketKind
  startMs: number
  endMs: number
  startIso: string
  endIso: string
}

/** A local aggregate; it never carries the source events or typed text. */
export interface ActivitySegment {
  id: string
  bucket: ActivityBucket
  eventCount: number
  meaningfulEventCount: number
  firstEventAtMs: number
  lastEventAtMs: number
  apps: string[]
  windowTitles: string[]
  summary: string
}

export interface ActivitySummaryOptions {
  maxApps?: number
  maxWindowTitles?: number
  maxLabelLength?: number
}

export interface HardFallbackGateInput {
  nowMs: number
  startedAtMs: number
  lastMeaningfulEventAtMs?: number | null
  lastFallbackAtMs?: number | null
  intervalMs?: number
}

function replaceWindowLocation(raw: string, label: '网址' | '本地回调'): string {
  const suffix = raw.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? ''
  return `[已隐去·${label}]${suffix}`
}

/** Keep ordinary document titles while removing locations and query parameters from activity history. */
export function sanitizeWindowTitle(input: string, maxLength = 160): string {
  return input
    .replace(HTTP_URL_RE, (raw) => replaceWindowLocation(raw, '网址'))
    .replace(LOOPBACK_CALLBACK_RE, (raw) => replaceWindowLocation(raw, '本地回调'))
    .replace(QUERY_PARAMS_RE, '[已隐去·查询参数]')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(0, maxLength))
}

const MEANINGFUL_KINDS: ReadonlySet<ActivityEventKind> = new Set([
  'click',
  'right_click',
  'drag',
  'shortcut',
  'submit',
  'selection_changed',
  'input_activity',
  'ax_focus_changed',
  'ax_attribute_changed',
  'screen_changed'
])

function finiteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function normalizeSignaturePart(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

/** Stable content signature. IDs and timestamps are excluded for windowed dedupe. */
export function activityEventSignature(event: ActivityEvent): string {
  const parts = [
    event.kind,
    normalizeSignaturePart(event.appName),
    normalizeSignaturePart(event.bundleId),
    normalizeSignaturePart(event.windowTitle),
    normalizeSignaturePart(event.urlHost),
    Number.isFinite(event.windowId) ? String(Math.trunc(event.windowId!)) : '',
    normalizeSignaturePart(event.targetRole),
    normalizeSignaturePart(event.targetId),
    normalizeSignaturePart(event.focusedRole),
    normalizeSignaturePart(event.focusedSubrole),
    normalizeSignaturePart(event.targetSubrole),
    normalizeSignaturePart(event.safeLabel),
    normalizeSignaturePart(event.command),
    [...(event.modifiers ?? [])].map(normalizeSignaturePart).sort().join('+'),
    Number.isFinite(event.inputLength) ? String(event.inputLength) : '',
    event.secureInput ? 'secure' : '',
    event.suppressed ? 'suppressed' : '',
    event.privacyState && event.privacyState !== 'normal' ? event.privacyState : ''
  ]
  return `ae1-${fnv1a64(JSON.stringify(parts))}`
}

/** Sort chronologically and keep the earliest equivalent event in each window. */
export function dedupeActivityEvents(
  events: readonly ActivityEvent[],
  windowMs = ACTIVITY_DEDUPE_WINDOW_MS
): ActivityEvent[] {
  const effectiveWindowMs = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : 0
  const lastSeen = new Map<string, number>()
  const result: ActivityEvent[] = []

  const chronological = events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((a, b) => {
      const aValid = finiteTimestamp(a.event.occurredAtMs)
      const bValid = finiteTimestamp(b.event.occurredAtMs)
      if (aValid !== bValid) return aValid ? -1 : 1
      if (!aValid) return a.inputIndex - b.inputIndex
      return a.event.occurredAtMs - b.event.occurredAtMs || a.inputIndex - b.inputIndex
    })

  for (const { event } of chronological) {
    if (!finiteTimestamp(event.occurredAtMs)) {
      result.push(event)
      continue
    }
    const signature = activityEventSignature(event)
    const previousAtMs = lastSeen.get(signature)
    if (previousAtMs !== undefined && Math.abs(event.occurredAtMs - previousAtMs) <= effectiveWindowMs)
      continue
    lastSeen.set(signature, event.occurredAtMs)
    result.push(event)
  }
  return result
}

function bucketSize(kind: ActivityBucketKind): number {
  return kind === '10m' ? TEN_MINUTES_MS : SIX_HOURS_MS
}

/** Epoch-aligned buckets are UTC by construction; endMs/endIso are exclusive. */
export function utcActivityBucket(timestampMs: number, kind: ActivityBucketKind): ActivityBucket {
  if (!finiteTimestamp(timestampMs)) throw new RangeError('timestampMs must be a finite non-negative number')
  const sizeMs = bucketSize(kind)
  const startMs = Math.floor(timestampMs / sizeMs) * sizeMs
  const endMs = startMs + sizeMs
  return {
    kind,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString()
  }
}

export function utcTenMinuteBucket(timestampMs: number): ActivityBucket {
  return utcActivityBucket(timestampMs, '10m')
}

export function utcSixHourBucket(timestampMs: number): ActivityBucket {
  return utcActivityBucket(timestampMs, '6h')
}

/** Context-only app/window/idle events do not justify a model call by themselves. */
export function isMeaningfulActivityEvent(event: ActivityEvent): boolean {
  if (event.suppressed || event.secureInput || !finiteTimestamp(event.occurredAtMs)) return false
  if (event.kind === 'input_activity') return (event.inputLength ?? 0) > 0
  return MEANINGFUL_KINDS.has(event.kind)
}

export function clampHardFallbackInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return HARD_FALLBACK_DEFAULT_INTERVAL_MS
  return Math.min(
    HARD_FALLBACK_MAX_INTERVAL_MS,
    Math.max(HARD_FALLBACK_MIN_INTERVAL_MS, Math.round(intervalMs))
  )
}

/**
 * Permit a screenshot/OCR fallback only after semantic activity has been quiet.
 * A previous fallback resets the same gate so repeated scans stay bounded.
 */
export function shouldRunHardFallback(input: HardFallbackGateInput): boolean {
  if (!finiteTimestamp(input.nowMs) || !finiteTimestamp(input.startedAtMs)) return false
  const anchors = [input.startedAtMs]
  if (input.lastMeaningfulEventAtMs != null && finiteTimestamp(input.lastMeaningfulEventAtMs))
    anchors.push(input.lastMeaningfulEventAtMs)
  if (input.lastFallbackAtMs != null && finiteTimestamp(input.lastFallbackAtMs))
    anchors.push(input.lastFallbackAtMs)
  const lastActivityAtMs = Math.max(...anchors)
  if (input.nowMs < lastActivityAtMs) return false
  const intervalMs = clampHardFallbackInterval(
    input.intervalMs ?? HARD_FALLBACK_DEFAULT_INTERVAL_MS
  )
  return input.nowMs - lastActivityAtMs >= intervalMs
}

function cleanLabel(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned.slice(0, maxLength)
}

function uniqueLabels(
  events: readonly ActivityEvent[],
  pick: (event: ActivityEvent) => string | null | undefined,
  limit: number,
  maxLength: number
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const label = cleanLabel(pick(event), maxLength)
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(label)
    if (result.length >= limit) break
  }
  return result
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}

/** Build deterministic, size-bounded local text from safe event metadata. */
export function buildActivitySegmentSummary(
  events: readonly ActivityEvent[],
  options: ActivitySummaryOptions = {}
): Pick<ActivitySegment, 'apps' | 'windowTitles' | 'summary'> {
  const maxApps = positiveInteger(options.maxApps, 5)
  const maxWindowTitles = positiveInteger(options.maxWindowTitles, 8)
  const maxLabelLength = positiveInteger(options.maxLabelLength, 120)
  const safeEvents = events.filter((event) => !event.secureInput && !event.suppressed)
  const apps = uniqueLabels(safeEvents, (event) => event.appName, maxApps, maxLabelLength)
  const windowTitles = uniqueLabels(
    safeEvents,
    (event) => event.windowTitle == null ? null : sanitizeWindowTitle(event.windowTitle, maxLabelLength),
    maxWindowTitles,
    maxLabelLength
  )
  const meaningfulCount = events.filter(isMeaningfulActivityEvent).length
  const appPart = apps.length ? apps.join(', ') : '(unknown)'
  const windowPart = windowTitles.length ? windowTitles.join(' | ') : '(none)'
  return {
    apps,
    windowTitles,
    summary: `Apps: ${appPart}; Windows: ${windowPart}; Meaningful events: ${meaningfulCount}/${events.length}`
  }
}

/** Group valid events into chronological UTC segments. */
export function buildActivitySegments(
  events: readonly ActivityEvent[],
  kind: ActivityBucketKind = '10m',
  options: ActivitySummaryOptions = {}
): ActivitySegment[] {
  const sorted = events
    .filter((event) => finiteTimestamp(event.occurredAtMs))
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((a, b) => a.event.occurredAtMs - b.event.occurredAtMs || a.inputIndex - b.inputIndex)
  const groups = new Map<number, ActivityEvent[]>()
  for (const { event } of sorted) {
    const bucket = utcActivityBucket(event.occurredAtMs, kind)
    const group = groups.get(bucket.startMs) ?? []
    group.push(event)
    groups.set(bucket.startMs, group)
  }

  return [...groups.entries()].map(([startMs, group]) => {
    const bucket = utcActivityBucket(startMs, kind)
    const local = buildActivitySegmentSummary(group, options)
    return {
      id: `activity-${kind}-${bucket.startIso}`,
      bucket,
      eventCount: group.length,
      meaningfulEventCount: group.filter(isMeaningfulActivityEvent).length,
      firstEventAtMs: group[0].occurredAtMs,
      lastEventAtMs: group[group.length - 1].occurredAtMs,
      ...local
    }
  })
}

export function activityCutoffMs(nowMs: number): number {
  if (!finiteTimestamp(nowMs)) throw new RangeError('nowMs must be a finite non-negative number')
  return nowMs - ACTIVITY_RETENTION_MS
}

/** The 48-hour boundary is retained; only strictly older events expire. */
export function isActivityEventRetained(event: ActivityEvent, nowMs: number): boolean {
  return finiteTimestamp(event.occurredAtMs) && event.occurredAtMs >= activityCutoffMs(nowMs)
}

export function retainedActivityEvents(
  events: readonly ActivityEvent[],
  nowMs: number
): ActivityEvent[] {
  return events.filter((event) => isActivityEventRetained(event, nowMs))
}
