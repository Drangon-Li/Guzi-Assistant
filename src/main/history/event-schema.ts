import {
  sanitizeWindowTitle,
  type ActivityEvent,
  type ActivityEventKind,
  type ActivityEventSource,
  type ActivityPrivacyState
} from '../../shared/activity-events.ts'
import { redactSensitive } from '../../shared/sensitive.ts'

export const HISTORY_EVENT_SCHEMA_VERSION = 1

export type HistoryPrivacyState = ActivityPrivacyState

export interface HistoryEvent {
  id: string
  occurred_at: string
  kind: ActivityEventKind
  source: ActivityEventSource
  app_name: string | null
  bundle_id: string | null
  window_title: string | null
  url_host: string | null
  target_role: string | null
  target_label: string | null
  command: string | null
  modifiers: string[]
  input_length: number | null
  secure_input: boolean
  privacy_state: HistoryPrivacyState
  suppressed: boolean
}

export interface HistoryEventConversion {
  event: HistoryEvent | null
  suppressed: boolean
  invalid: boolean
  reason: string | null
}

const EVENT_KINDS: ReadonlySet<string> = new Set([
  'app_activated',
  'window_changed',
  'click',
  'right_click',
  'drag',
  'shortcut',
  'submit',
  'selection_changed',
  'input_activity',
  'ax_focus_changed',
  'ax_attribute_changed',
  'screen_changed',
  'idle_started',
  'idle_ended'
])
const EVENT_SOURCES: ReadonlySet<string> = new Set(['accessibility', 'workspace', 'fallback', 'collector'])
const PRIVACY_STATES: ReadonlySet<string> = new Set(['normal', 'private', 'excluded', 'own', 'secure'])
const PERSISTED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'occurred_at',
  'kind',
  'source',
  'app_name',
  'bundle_id',
  'window_title',
  'url_host',
  'target_role',
  'target_label',
  'command',
  'modifiers',
  'input_length',
  'secure_input',
  'privacy_state',
  'suppressed'
])

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const out = value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max)
  return out || null
}

function cleanObserved(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  return clean(redactSensitive(value).text, max)
}

function cleanHost(value: unknown): string | null {
  const out = clean(value, 255)
  if (out && /^\[[0-9a-f:]+\](?::\d{1,5})?$/i.test(out)) return out.toLowerCase()
  const match = out?.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i)
  if (!match || (match[2] != null && Number(match[2]) > 65_535)) return null
  return out?.toLowerCase() ?? null
}

function cleanModifiers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => clean(item, 32))
    .filter((item): item is string => !!item)
    .slice(0, 8)
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
}

function privacyStateOf(event: ActivityEvent): HistoryPrivacyState {
  return event.privacyState ?? (event.suppressed || event.secureInput ? 'secure' : 'normal')
}

/** Convert a sanitized in-memory event to the persisted snake_case contract. */
export function convertActivityEvent(event: ActivityEvent): HistoryEventConversion {
  if (!event || typeof event !== 'object')
    return { event: null, suppressed: false, invalid: true, reason: 'event_not_object' }
  if (typeof event.id !== 'string' || !event.id.trim())
    return { event: null, suppressed: false, invalid: true, reason: 'missing_id' }
  if (!finiteTimestamp(event.occurredAtMs))
    return { event: null, suppressed: false, invalid: true, reason: 'invalid_timestamp' }
  if (!EVENT_KINDS.has(event.kind) || !EVENT_SOURCES.has(event.source))
    return { event: null, suppressed: false, invalid: true, reason: 'invalid_kind_or_source' }
  if (event.privacyState != null && !PRIVACY_STATES.has(event.privacyState))
    return { event: null, suppressed: false, invalid: true, reason: 'invalid_privacy_state' }

  const privacyState = privacyStateOf(event)
  const secureRole = /secure|password|secret/i.test(
    `${event.focusedRole ?? ''} ${event.focusedSubrole ?? ''} ${event.targetRole ?? ''} ${event.targetSubrole ?? ''}`
  )
  if (event.suppressed || event.secureInput || secureRole || privacyState !== 'normal') {
    return {
      event: null,
      suppressed: true,
      invalid: false,
      reason: `privacy_${secureRole || event.secureInput ? 'secure' : privacyState}`
    }
  }

  const appName = clean(event.appName, 80)
  const bundleId = clean(event.bundleId, 160)
  const windowTitle = event.windowTitle == null ? null : sanitizeWindowTitle(cleanObserved(event.windowTitle, 160) ?? '', 160) || null
  const targetLabel = event.safeLabel == null ? null : sanitizeWindowTitle(cleanObserved(event.safeLabel, 160) ?? '', 160) || null
  const inputLength =
    event.inputLength == null || !Number.isFinite(event.inputLength)
      ? null
      : Math.max(0, Math.min(100_000, Math.trunc(event.inputLength)))

  return {
    event: {
      id: event.id.trim().slice(0, 160),
      occurred_at: new Date(event.occurredAtMs).toISOString(),
      kind: event.kind,
      source: event.source,
      app_name: appName,
      bundle_id: bundleId,
      window_title: windowTitle,
      url_host: cleanHost(event.urlHost),
      target_role: clean(event.targetRole ?? event.focusedRole, 80),
      target_label: targetLabel,
      command: cleanObserved(event.command, 80),
      modifiers: cleanModifiers(event.modifiers),
      input_length: inputLength,
      secure_input: false,
      privacy_state: 'normal',
      suppressed: false
    },
    suppressed: false,
    invalid: false,
    reason: null
  }
}

/** Validate a JSONL object without accepting raw text or unknown privacy states. */
export function parseHistoryEvent(value: unknown): HistoryEvent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const occurredAtMs = typeof raw.occurred_at === 'string' ? Date.parse(raw.occurred_at) : NaN
  if (Object.keys(raw).some((key) => !PERSISTED_KEYS.has(key))) return null
  if (
    typeof raw.id !== 'string' ||
    typeof raw.occurred_at !== 'string' ||
    !finiteTimestamp(occurredAtMs) ||
    typeof raw.kind !== 'string' ||
    !EVENT_KINDS.has(raw.kind) ||
    typeof raw.source !== 'string' ||
    !EVENT_SOURCES.has(raw.source) ||
    typeof raw.privacy_state !== 'string' ||
    !PRIVACY_STATES.has(raw.privacy_state) ||
    raw.privacy_state !== 'normal' ||
    raw.suppressed !== false ||
    raw.secure_input !== false
  )
    return null
  if (!raw.id.trim()) return null
  for (const key of [
    'app_name',
    'bundle_id',
    'window_title',
    'url_host',
    'target_role',
    'target_label',
    'command'
  ]) {
    if (raw[key] != null && typeof raw[key] !== 'string') return null
  }
  if (raw.modifiers != null && !Array.isArray(raw.modifiers)) return null
  if (raw.input_length != null && (typeof raw.input_length !== 'number' || !Number.isFinite(raw.input_length))) return null
  if (/secure|password|secret/i.test(String(raw.target_role ?? ''))) return null
  const modifiers = cleanModifiers(raw.modifiers)
  const inputLength =
    raw.input_length == null || !Number.isFinite(raw.input_length)
      ? null
      : Math.max(0, Math.min(100_000, Math.trunc(raw.input_length as number)))
  return {
    id: raw.id.trim().slice(0, 160),
    occurred_at: new Date(occurredAtMs).toISOString(),
    kind: raw.kind as ActivityEventKind,
    source: raw.source as ActivityEventSource,
    app_name: clean(raw.app_name, 80),
    bundle_id: clean(raw.bundle_id, 160),
    window_title:
      raw.window_title == null
        ? null
        : sanitizeWindowTitle(cleanObserved(String(raw.window_title), 160) ?? '', 160) || null,
    url_host: cleanHost(raw.url_host),
    target_role: clean(raw.target_role, 80),
    target_label:
      raw.target_label == null
        ? null
        : sanitizeWindowTitle(cleanObserved(String(raw.target_label), 160) ?? '', 160) || null,
    command: cleanObserved(raw.command, 80),
    modifiers,
    input_length: inputLength,
    secure_input: false,
    privacy_state: 'normal',
    suppressed: false
  }
}

export function isMeaningfulHistoryEvent(event: HistoryEvent): boolean {
  if (event.kind === 'input_activity') return (event.input_length ?? 0) > 0
  return new Set([
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
  ]).has(event.kind)
}
