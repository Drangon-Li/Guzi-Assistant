import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CollectorPolicy } from '../src/main/history/collector-policy.ts'
import {
  configureActivityHistoryPersistence,
  getScreenActivityStatus,
  recordCollectorEvent,
  resetActivityGate
} from '../src/main/activity-tracker.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed += 1
}

const base = {
  kind: 'click',
  source: 'collector',
  appName: 'Code',
  bundleId: 'com.microsoft.VSCode',
  windowTitle: 'activity-tracker.ts',
  command: 'pointer_action',
  occurredAtMs: 1_000
}
let now = 0
const policy = new CollectorPolicy({ now: () => now, maxEventsPerSecond: 2, dedupeWindowMs: 750, backoffBaseMs: 100, backoffMaxMs: 400 })
check('first collector event is accepted', policy.accept(base, now).accepted)
now = 100
check('equivalent collector event is deduplicated', policy.accept({ ...base, occurredAtMs: now }, now).reason === 'duplicate')
now = 200
check('different event is accepted within rate window', policy.accept({ ...base, command: 'other_action', occurredAtMs: now }, now).accepted)
now = 300
check('per-bundle rate limit drops excess events', policy.accept({ ...base, command: 'third_action', occurredAtMs: now }, now).reason === 'rate_limited')
policy.recordBundleFailure(base.bundleId, now)
now = 350
check('per-bundle backoff drops events during timeout', policy.accept({ ...base, command: 'after_failure', occurredAtMs: now }, now).reason === 'backoff')
now = 1_200
policy.recordBundleSuccess(base.bundleId)
check('bundle success clears backoff', policy.accept({ ...base, command: 'recovered', occurredAtMs: now }, now).accepted)
check('gate exposes drop and backoff metrics', policy.snapshot().droppedCount >= 3 && policy.snapshot().backoffDroppedCount >= 1)
check(
  'suppressed events bypass normal dedupe/rate gate',
  policy.accept({ ...base, suppressed: true, privacyState: 'secure', occurredAtMs: now }, now).accepted
)

const fixtureText = await readFile(new URL('./fixtures/history-collector-events.jsonl', import.meta.url), 'utf8')
const fixtureEvents = fixtureText
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const persisted = []
resetActivityGate(1_700_000_000_000)
configureActivityHistoryPersistence({
  upsertSegment: () => {},
  addOcrEvidence: () => {},
  appendHistoryEvent: (event) => persisted.push(event)
})
const privacyForContext = (context) => {
  if (
    context.secureInput ||
    /secure|password|secret/i.test(
      `${context.focusedRole ?? ''} ${context.focusedSubrole ?? ''} ${context.targetRole ?? ''} ${context.targetSubrole ?? ''}`
    )
  )
    return { suppressed: true, privacyState: 'secure' }
  if (context.bundleId === 'com.google.Chrome' && /incognito/i.test(context.windowTitle))
    return { suppressed: true, privacyState: 'private' }
  if (context.name.toLowerCase().includes('slack')) return { suppressed: true, privacyState: 'excluded' }
  return { suppressed: false, privacyState: 'normal' }
}
for (const event of fixtureEvents) recordCollectorEvent(event, privacyForContext)
configureActivityHistoryPersistence(null)

const normalKinds = new Set(persisted.filter((event) => !event.suppressed).map((event) => event.kind))
for (const kind of ['app_activated', 'window_changed', 'ax_focus_changed', 'ax_attribute_changed', 'click', 'right_click', 'drag', 'shortcut', 'selection_changed', 'input_activity'])
  check(`${kind} fixture reaches ActivityEvent`, normalKinds.has(kind))
const input = persisted.find((event) => event.kind === 'input_activity' && !event.suppressed)
check('input burst stores length and action type only', input?.inputLength === 12 && input.command === 'typing_burst')
check('input burst has no keyboard正文 fields', input && !('text' in input) && !('characters' in input) && !('keyCode' in input))
const secureSubrole = persisted.find((event) => event.kind === 'input_activity' && event.suppressed)
const secureFixture = fixtureEvents.find((event) => event.type === 'input_activity' && event.appName === 'Keychain')
const postSwitchFocus = persisted.find(
  (event) => event.kind === 'ax_focus_changed' && event.bundleId === 'com.apple.keychainaccess' && !event.suppressed
)
check(
  'AXSecureTextField subrole is suppressed even with ordinary AXTextField role',
  secureFixture?.focusedRole === 'AXTextField' &&
    secureFixture?.focusedSubrole === 'AXSecureTextField' &&
    secureSubrole?.privacyState === 'secure'
)
check(
  'password burst stays suppressed across immediate focus switch',
  secureSubrole?.suppressed === true && postSwitchFocus?.focusedSubrole === 'AXTextField'
)
const browserEvent = persisted.find((event) => event.bundleId === 'com.google.Chrome' && event.windowTitle === 'Docs')
check('browser activity keeps host only', browserEvent?.urlHost === 'docs.example.test' && !('url' in browserEvent))
const sameTitleWindowIds = persisted
  .filter((event) => event.windowTitle === 'same-title.txt')
  .map((event) => event.windowId)
check('same-title windows remain distinct by windowId', sameTitleWindowIds.includes(202) && sameTitleWindowIds.includes(303))
const suppressed = persisted.filter((event) => event.suppressed)
check('secure/private/excluded fixtures only produce suppressed events', suppressed.length === 3)
check('suppressed events do not retain app or window payload', suppressed.every((event) => !event.appName && !event.bundleId && !event.windowTitle))
const status = getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
check('collector health exposes gate counters', status.collectorDroppedEventCount >= 0 && status.collectorBackoffBundleCount >= 0)
check('heartbeat survives an empty foreground context', status.accessibility === 'unavailable' && status.inputMonitoring === 'unavailable')
recordCollectorEvent(
  {
    type: 'heartbeat',
    appName: '',
    bundleId: '',
    windowTitle: '',
    accessibility: 'unavailable',
    inputMonitoring: 'available',
    occurredAtMs: 1_700_000_000_140
  },
  privacyForContext
)
const mixedHealthStatus = getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
check(
  'Input Monitoring health is independent from Accessibility health',
  mixedHealthStatus.accessibility === 'unavailable' && mixedHealthStatus.inputMonitoring === 'available'
)

resetActivityGate(1_700_000_100_000)
recordCollectorEvent(
  {
    type: 'app_activated',
    appName: 'Slow App',
    bundleId: 'com.example.slow',
    windowTitle: 'main',
    accessibility: 'unavailable',
    occurredAtMs: 1_700_000_100_001
  },
  () => ({ suppressed: false, privacyState: 'normal' })
)
const degradedStatus = getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
check('AX unavailable is visible as degraded/unavailable', degradedStatus.observer === 'unavailable' || degradedStatus.collector === 'degraded')
check('AX failure creates an active bundle backoff', degradedStatus.collectorBackoffBundleCount >= 1)

assert.equal(failed, 0)
console.log('\nAll collector checks passed')
process.exit(failed ? 1 : 0)
