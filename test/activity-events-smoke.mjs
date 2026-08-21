// Pure activity-event core smoke tests. Run: node test/activity-events-smoke.mjs
import {
  ACTIVITY_RETENTION_MS,
  activityCutoffMs,
  activityEventSignature,
  buildActivitySegments,
  clampHardFallbackInterval,
  dedupeActivityEvents,
  isActivityEventRetained,
  isMeaningfulActivityEvent,
  retainedActivityEvents,
  shouldRunHardFallback,
  utcSixHourBucket,
  utcTenMinuteBucket
} from '../src/shared/activity-events.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const at = (iso) => Date.parse(iso)
const event = (overrides = {}) => ({
  id: 'e1',
  occurredAtMs: at('2026-08-20T10:03:00.000Z'),
  kind: 'click',
  source: 'accessibility',
  appName: 'Code',
  bundleId: 'com.microsoft.VSCode',
  windowTitle: 'activity-events.ts',
  targetRole: 'button',
  targetId: 'save',
  ...overrides
})

// UTC buckets
const ten = utcTenMinuteBucket(at('2026-08-20T10:09:59.999Z'))
check('10min bucket floors in UTC', ten.startIso === '2026-08-20T10:00:00.000Z')
check('10min bucket end is exclusive', ten.endIso === '2026-08-20T10:10:00.000Z')
check(
  '10min right boundary enters next bucket',
  utcTenMinuteBucket(at('2026-08-20T10:10:00.000Z')).startIso === '2026-08-20T10:10:00.000Z'
)
const six = utcSixHourBucket(at('2026-08-20T11:59:59.999Z'))
check('6h bucket floors to UTC 06:00', six.startIso === '2026-08-20T06:00:00.000Z')
check(
  '6h right boundary enters UTC 12:00',
  utcSixHourBucket(at('2026-08-20T12:00:00.000Z')).startIso === '2026-08-20T12:00:00.000Z'
)

// Signature and dedupe
const canonical = event({ modifiers: ['Shift', 'CMD'] })
const normalized = event({
  id: 'e2',
  appName: ' code ',
  bundleId: 'COM.MICROSOFT.VSCODE',
  windowTitle: 'activity-events.ts',
  modifiers: ['cmd', 'shift'],
  occurredAtMs: canonical.occurredAtMs + 750
})
check('signature ignores id/time and normalizes metadata', activityEventSignature(canonical) === activityEventSignature(normalized))
check('dedupe removes equivalent event at inclusive 750ms edge', dedupeActivityEvents([canonical, normalized]).length === 1)
check(
  'dedupe keeps equivalent event outside window',
  dedupeActivityEvents([canonical, { ...normalized, occurredAtMs: canonical.occurredAtMs + 751 }]).length === 2
)
check(
  'dedupe keeps distinct targets',
  dedupeActivityEvents([canonical, { ...normalized, targetId: 'run' }]).length === 2
)
const outOfOrder = dedupeActivityEvents([
  { ...canonical, id: 'late', occurredAtMs: canonical.occurredAtMs + 2_000 },
  { ...canonical, id: 'early', occurredAtMs: canonical.occurredAtMs },
  { ...canonical, id: 'duplicate', occurredAtMs: canonical.occurredAtMs + 500 }
])
check(
  'dedupe handles out-of-order input and returns chronological events',
  eq(outOfOrder.map((item) => item.id), ['early', 'late'])
)

// Meaningful-event policy
check('click is meaningful', isMeaningfulActivityEvent(event()))
check('window change is context-only', !isMeaningfulActivityEvent(event({ kind: 'window_changed' })))
check('app activation is context-only', !isMeaningfulActivityEvent(event({ kind: 'app_activated' })))
check('positive input metadata is meaningful', isMeaningfulActivityEvent(event({ kind: 'input_activity', inputLength: 4 })))
check('zero-length input metadata is not meaningful', !isMeaningfulActivityEvent(event({ kind: 'input_activity', inputLength: 0 })))
check('screen change is meaningful', isMeaningfulActivityEvent(event({ kind: 'screen_changed', source: 'fallback' })))
check('secure input never becomes meaningful', !isMeaningfulActivityEvent(event({ secureInput: true })))
check('suppressed event never becomes meaningful', !isMeaningfulActivityEvent(event({ suppressed: true })))

// Hard fallback gate
const START = 1_000_000
check('fallback interval clamps low values to 30s', clampHardFallbackInterval(1) === 30_000)
check('fallback interval clamps high values to 60s', clampHardFallbackInterval(90_000) === 60_000)
check('fallback interval uses 45s for NaN', clampHardFallbackInterval(NaN) === 45_000)
check(
  'fallback stays closed before threshold',
  !shouldRunHardFallback({ nowMs: START + 29_999, startedAtMs: START, intervalMs: 1 })
)
check(
  'fallback opens at inclusive threshold',
  shouldRunHardFallback({ nowMs: START + 30_000, startedAtMs: START, intervalMs: 1 })
)
check(
  'meaningful event resets fallback silence',
  !shouldRunHardFallback({
    nowMs: START + 50_000,
    startedAtMs: START,
    lastMeaningfulEventAtMs: START + 30_000,
    intervalMs: 30_000
  })
)
check(
  'previous fallback also resets gate',
  !shouldRunHardFallback({
    nowMs: START + 60_000,
    startedAtMs: START,
    lastFallbackAtMs: START + 45_000,
    intervalMs: 30_000
  })
)
check(
  'future anchor fails closed',
  !shouldRunHardFallback({ nowMs: START, startedAtMs: START + 1, intervalMs: 30_000 })
)

// Deterministic segments and bounded labels
const segmentEvents = [
  event({ id: 'late', occurredAtMs: at('2026-08-20T10:09:00.000Z'), appName: 'Code', windowTitle: 'One' }),
  event({ id: 'early', occurredAtMs: at('2026-08-20T10:01:00.000Z'), kind: 'window_changed', appName: 'Safari', windowTitle: 'Two' }),
  event({ id: 'case-dup', occurredAtMs: at('2026-08-20T10:02:00.000Z'), appName: 'safari', windowTitle: 'two' }),
  event({ id: 'next', occurredAtMs: at('2026-08-20T10:10:00.000Z'), appName: 'Mail', windowTitle: 'Inbox' })
]
const segments = buildActivitySegments(segmentEvents, '10m', { maxApps: 2, maxWindowTitles: 2 })
check('events split across UTC bucket boundary', segments.length === 2)
check('segments are chronological despite unordered input', segments[0].firstEventAtMs === at('2026-08-20T10:01:00.000Z'))
check('apps dedupe case-insensitively and preserve first spelling', eq(segments[0].apps, ['Safari', 'Code']))
check('window titles dedupe and obey limit', eq(segments[0].windowTitles, ['Two', 'One']))
check('segment counts meaningful events locally', segments[0].meaningfulEventCount === 2 && segments[0].eventCount === 3)
check('summary is deterministic', segments[0].summary === 'Apps: Safari, Code; Windows: Two | One; Meaningful events: 2/3')
check(
  'labels are clipped before summary',
  buildActivitySegments([event({ appName: '123456', windowTitle: 'abcdef' })], '10m', { maxLabelLength: 3 })[0].summary.includes('Apps: 123; Windows: abc')
)
check(
  'secure and suppressed labels never enter summary',
  buildActivitySegments([
    event({ appName: 'Visible', windowTitle: 'Safe' }),
    event({ id: 'secure', appName: 'Password Manager', windowTitle: 'Secret', secureInput: true }),
    event({ id: 'blocked', appName: 'Blocked App', windowTitle: 'Private', suppressed: true })
  ])[0].summary === 'Apps: Visible; Windows: Safe; Meaningful events: 1/3'
)
const rawUrlSegment = buildActivitySegments([
  event({
    windowTitle: 'OAuth callback https://accounts.example/callback?state=secret-state&code=secret-code'
  })
])[0]
check(
  'segment summary applies URL privacy boundary to raw events',
  rawUrlSegment.windowTitles[0] === 'OAuth callback [已隐去·网址]' &&
    !/https?:|state=|code=|secret-state|secret-code/.test(rawUrlSegment.summary)
)

// 48-hour retention
const NOW = at('2026-08-20T12:00:00.000Z')
const cutoff = NOW - ACTIVITY_RETENTION_MS
check('cutoff is exactly 48h', activityCutoffMs(NOW) === cutoff)
check('event exactly at cutoff is retained', isActivityEventRetained(event({ occurredAtMs: cutoff }), NOW))
check('event 1ms before cutoff expires', !isActivityEventRetained(event({ occurredAtMs: cutoff - 1 }), NOW))
check(
  'retention filter keeps boundary and fresh event',
  eq(
    retainedActivityEvents(
      [event({ id: 'old', occurredAtMs: cutoff - 1 }), event({ id: 'edge', occurredAtMs: cutoff }), event({ id: 'fresh', occurredAtMs: NOW })],
      NOW
    ).map((item) => item.id),
    ['edge', 'fresh']
  )
)

console.log(failed ? `\n${failed} items failed` : '\nAll activity-event tests passed')
process.exit(failed ? 1 : 0)
