import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convertActivityEvent,
  isMeaningfulHistoryEvent,
  parseHistoryEvent
} from '../src/main/history/event-schema.ts'
import { decideHistoryPrivacy } from '../src/main/history/privacy-policy.ts'
import { normalizeHistoryHost } from '../src/shared/history.ts'
import {
  HISTORY_RETENTION_MS,
  historyCutoffMs,
  isHistoryEventRetained,
  isSegmentExpired
} from '../src/main/history/retention.ts'
import { HistorySegmentStore } from '../src/main/history/event-store.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed += 1
}

const NOW = Date.parse('2026-08-22T12:00:00.000Z')
const event = (overrides = {}) => ({
  id: `event-${Math.random().toString(16).slice(2)}`,
  occurredAtMs: NOW,
  kind: 'click',
  source: 'accessibility',
  appName: 'Code',
  bundleId: 'com.microsoft.VSCode',
  windowTitle: 'history.ts',
  targetRole: 'button',
  ...overrides
})

function makeIndex() {
  const rows = new Map()
  return {
    upsert(metadata) {
      rows.set(metadata.id, structuredClone(metadata))
    },
    remove(id) {
      rows.delete(id)
    },
    get(id) {
      return rows.get(id) ? structuredClone(rows.get(id)) : null
    },
    list() {
      return [...rows.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)).map((row) => structuredClone(row))
    },
    count() {
      return rows.size
    }
  }
}

const metadataKeys = [
  'id',
  'bucketStart',
  'bucketEnd',
  'eventsPath',
  'eventCount',
  'meaningfulEventCount',
  'suppressedEventCount',
  'summaryStatus',
  'summaryText',
  'summaryJson',
  'retentionExpiresAt',
  'createdAt',
  'updatedAt'
]

function metadataMatches(left, right) {
  return metadataKeys.every((key) => left?.[key] === right?.[key])
}

function metadataPath(root, row) {
  return join(root, row.eventsPath.replace(/events\.jsonl$/, 'metadata.json'))
}

// Schema and privacy boundary.
const converted = convertActivityEvent(event({
  id: 'normal-1',
  windowTitle: 'Sign in - https://example.test/callback?code=secret',
  urlHost: 'Example.TEST:443',
  inputLength: 12
}))
check('normal event converts', !!converted.event && !converted.invalid)
check('URL is reduced to host and title is redacted', converted.event?.url_host === 'example.test:443' && !converted.event?.window_title?.includes('secret'))
check('meaningful event classification is stable', converted.event ? isMeaningfulHistoryEvent(converted.event) : false)
check('secure event is suppressed before persistence', convertActivityEvent(event({ secureInput: true })).suppressed)
check('secure accessibility role is suppressed before persistence', convertActivityEvent(event({ targetRole: 'AXSecureTextField' })).suppressed)
check('raw text key is rejected by persisted schema', parseHistoryEvent({ ...converted.event, text: 'do not store' }) === null)
check('unknown privacy state is rejected', parseHistoryEvent({ ...converted.event, privacy_state: 'mystery' }) === null)

check(
  'private browser policy suppresses',
  decideHistoryPrivacy({ appName: 'Google Chrome', bundleId: 'com.google.Chrome', windowTitle: 'Incognito Window' }).state === 'private'
)
check(
  'own app policy suppresses',
  decideHistoryPrivacy({ appName: '谷子助手', ownAppNames: ['谷子助手'] }).state === 'own'
)
check(
  'excluded app policy suppresses',
  decideHistoryPrivacy({ appName: 'Slack', excludedApps: ['slack'] }).state === 'excluded'
)
check(
  'selected app Bundle ID policy suppresses',
  decideHistoryPrivacy({ appName: 'Safari', bundleId: 'com.apple.Safari', excludedBundleIds: ['com.apple.safari'] }).reason === 'excluded_app'
)
check(
  'include list suppresses apps outside the selected set',
  decideHistoryPrivacy({ appName: 'Slack', includedApps: ['Code'] }).state === 'excluded'
)
check(
  'include list keeps matching apps',
  decideHistoryPrivacy({ appName: 'Visual Studio Code', includedApps: ['code'] }).persist
)
check(
  'secure role policy suppresses',
  decideHistoryPrivacy({ appName: 'Keychain', focusedRole: 'AXSecureTextField' }).state === 'secure'
)
check(
  'secure target role policy suppresses',
  decideHistoryPrivacy({ appName: 'Keychain', targetRole: 'AXSecureTextField' }).state === 'secure'
)
check(
  'website exclude matches subdomains without storing a URL',
  decideHistoryPrivacy({ appName: 'Google Chrome', urlHost: 'docs.example.test', excludedHosts: ['example.test'] }).reason === 'excluded_host'
)
check(
  'website include keeps a matching host',
  decideHistoryPrivacy({ appName: 'Google Chrome', urlHost: 'docs.example.test', includedHosts: ['example.test'] }).persist
)
check(
  'website host rules preserve an explicit port',
  normalizeHistoryHost('docs.example.test:443') === 'docs.example.test:443' &&
    decideHistoryPrivacy({ appName: 'Google Chrome', urlHost: 'docs.example.test:443', excludedHosts: ['example.test:443'] }).reason === 'excluded_host'
)
check(
  'website include does not suppress a non-browser event without a host',
  decideHistoryPrivacy({ appName: 'Code', includedHosts: ['example.test'] }).persist
)
check(
  'full URL is rejected by host settings',
  normalizeHistoryHost('https://example.test/path') === null &&
    decideHistoryPrivacy({ appName: 'Google Chrome', urlHost: 'https://example.test/path' }).reason === 'invalid_url_host'
)

// Retention boundaries are inclusive for the event at exactly 48 hours.
check('retention constant is 48 hours', HISTORY_RETENTION_MS === 48 * 60 * 60 * 1000)
check('cutoff is exact', historyCutoffMs(NOW) === NOW - HISTORY_RETENTION_MS)
check('event at cutoff is retained', isHistoryEventRetained({ occurred_at: new Date(NOW - HISTORY_RETENTION_MS).toISOString() }, NOW))
check('event just before cutoff is removed', !isHistoryEventRetained({ occurred_at: new Date(NOW - HISTORY_RETENTION_MS - 1).toISOString() }, NOW))
check('expired segment boundary is inclusive', isSegmentExpired(NOW - HISTORY_RETENTION_MS, NOW))

const root = await mkdtemp(join(tmpdir(), 'guzi-history-'))
try {
  const index = makeIndex()
  const clock = () => NOW
  const store = new HistorySegmentStore({ rootDir: root, index, now: clock })
  await store.start()
  check('store starts healthy', store.health().state === 'healthy')

  store.append(event({ id: 'persisted-1', occurredAtMs: NOW + 1_000 }))
  await store.flush()
  check('first event creates one indexed segment', index.count() === 1)
  const first = index.list()[0]
  const firstBody = await readFile(join(root, first.eventsPath), 'utf8')
  check('JSONL contains one event', firstBody.trim().split('\n').length === 1)
  check('JSONL does not contain raw text fields', !/selected_text|typed_text|"text"/.test(firstBody))
  const firstDiskMetadata = JSON.parse(await readFile(metadataPath(root, first), 'utf8'))
  check('metadata.json matches SQLite after append', metadataMatches(firstDiskMetadata, index.get(first.id)))

  store.append(event({ id: 'persisted-2', occurredAtMs: NOW + 11 * 60 * 1000 }))
  await store.flush()
  check('UTC ten-minute boundary creates a second segment', index.count() === 2)

  store.append(event({ id: 'suppressed-1', occurredAtMs: NOW + 12 * 60 * 1000, suppressed: true, privacyState: 'private' }))
  await store.flush()
  const suppressedMeta = index.list().at(-1)
  check('suppressed event increments metadata only', (suppressedMeta?.suppressedEventCount ?? 0) === 1 && (suppressedMeta?.eventCount ?? 0) === 1)
  check('health reports suppressed count', store.health().suppressedCount === 1)
  const suppressedBody = await readFile(join(root, suppressedMeta.eventsPath), 'utf8')
  check('suppressed event is absent from JSONL', !suppressedBody.includes('suppressed-1'))
  check(
    'metadata.json matches SQLite after suppressed event',
    metadataMatches(JSON.parse(await readFile(metadataPath(root, suppressedMeta), 'utf8')), suppressedMeta)
  )

  // Simulate a crash after a complete line plus a trailing partial line.
  const segment = index.list()[0]
  const segmentPath = join(root, segment.eventsPath)
  await writeFile(segmentPath, `${await readFile(segmentPath, 'utf8')}{"id":"partial`)
  index.remove(segment.id)
  await store.close()
  const reopened = new HistorySegmentStore({ rootDir: root, index, now: clock })
  await reopened.start()
  await reopened.flush()
  const recovered = await readFile(segmentPath, 'utf8')
  check('trailing partial JSONL line is discarded on restart', recovered.trim().split('\n').length === 1)
  check('orphaned on-disk metadata is reindexed on restart', index.get(segment.id)?.eventCount === 1)
  await writeFile(segmentPath, `${await readFile(segmentPath, 'utf8')}not-json\n`)
  await reopened.cleanup(NOW)
  check('complete malformed JSONL lines are removed during reconciliation', !(await readFile(segmentPath, 'utf8')).includes('not-json'))
  check(
    'metadata.json matches SQLite after crash recovery',
    metadataMatches(
      JSON.parse(await readFile(metadataPath(root, index.get(segment.id)), 'utf8')),
      index.get(segment.id)
    )
  )
  const driftedRow = index.list()[0]
  const driftedMetadata = JSON.parse(await readFile(metadataPath(root, driftedRow), 'utf8'))
  driftedMetadata.eventCount = 999
  await writeFile(metadataPath(root, driftedRow), `${JSON.stringify(driftedMetadata)}\n`)
  await reopened.cleanup(NOW)
  check(
    'metadata drift is repaired from JSONL and reindexed',
    metadataMatches(JSON.parse(await readFile(metadataPath(root, driftedRow), 'utf8')), index.get(driftedRow.id))
  )

  // A crash can leave the JSON sidecar behind the SQLite index. The index must
  // win for suppressed counts, while ordinary counts still come from JSONL.
  const restartRow = index.list()[0]
  const restartMetadataPath = metadataPath(root, restartRow)
  const oldDiskMetadata = JSON.parse(await readFile(restartMetadataPath, 'utf8'))
  oldDiskMetadata.eventCount = 0
  oldDiskMetadata.meaningfulEventCount = 0
  oldDiskMetadata.suppressedEventCount = 0
  oldDiskMetadata.summaryStatus = 'pending'
  oldDiskMetadata.summaryText = null
  oldDiskMetadata.summaryJson = null
  oldDiskMetadata.eventsPath = '../../outside/events.jsonl'
  oldDiskMetadata.updatedAt = '2026-08-22T11:00:00.000Z'
  await reopened.close()
  await writeFile(restartMetadataPath, `${JSON.stringify(oldDiskMetadata)}\n`)
  const newerIndexMetadata = {
    ...index.get(restartRow.id),
    eventCount: 1,
    meaningfulEventCount: 1,
    suppressedEventCount: 7,
    summaryStatus: 'ready',
    summaryText: 'newer SQLite summary',
    summaryJson: '{"source":"sqlite"}',
    updatedAt: '2026-08-22T12:00:00.000Z'
  }
  index.upsert(newerIndexMetadata)
  const restarted = new HistorySegmentStore({ rootDir: root, index, now: clock })
  await restarted.start()
  await restarted.flush()
  const recoveredIndexMetadata = index.get(restartRow.id)
  const recoveredDiskMetadata = JSON.parse(await readFile(restartMetadataPath, 'utf8'))
  check(
    'restart recomputes event count from JSONL and keeps SQLite suppressed count',
    recoveredIndexMetadata?.eventCount === 1 && recoveredIndexMetadata?.meaningfulEventCount === 1 && recoveredIndexMetadata?.suppressedEventCount === 7
  )
  check(
    'restart keeps the newer SQLite summary metadata',
    recoveredIndexMetadata?.summaryStatus === 'ready' &&
      recoveredIndexMetadata?.summaryText === 'newer SQLite summary' &&
      recoveredIndexMetadata?.summaryJson === '{"source":"sqlite"}'
  )
  check(
    'restart restores the canonical segment events path',
    recoveredIndexMetadata?.eventsPath === restartRow.eventsPath && recoveredDiskMetadata.eventsPath === restartRow.eventsPath
  )
  check(
    'metadata.json and SQLite converge after stale sidecar recovery',
    metadataMatches(recoveredDiskMetadata, recoveredIndexMetadata)
  )

  // Add one event older than retention and one current event, then clean.
  index.upsert({
    id: 'stale-index',
    bucketStart: '2026-08-20T00:00:00.000Z',
    bucketEnd: '2026-08-20T00:10:00.000Z',
    eventsPath: 'segments/stale-index/events.jsonl',
    eventCount: 1,
    meaningfulEventCount: 1,
    suppressedEventCount: 0,
    summaryStatus: 'pending',
    summaryText: null,
    summaryJson: null,
    retentionExpiresAt: '2026-08-22T00:10:00.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z'
  })
  restarted.append(event({ id: 'old-1', occurredAtMs: NOW - HISTORY_RETENTION_MS - 60 * 60 * 1000 }))
  restarted.append(event({ id: 'new-1', occurredAtMs: NOW - 60 * 60 * 1000 }))
  await restarted.flush()
  await restarted.cleanup(NOW)
  const remaining = index.list()
  check('48-hour cleanup removes old segment but keeps recent segment', remaining.some((m) => m.eventCount > 0) && !remaining.some((m) => m.bucketStart === new Date(NOW - HISTORY_RETENTION_MS - 60 * 60 * 1000).toISOString()))
  check('cleanup health timestamp is set', restarted.health().lastCleanupAt !== null)
  check('stale SQLite row is removed when its files are missing', index.get('stale-index') === null)
  let allMetadataMatches = true
  for (const row of index.list()) {
    try {
      allMetadataMatches = allMetadataMatches && metadataMatches(JSON.parse(await readFile(metadataPath(root, row), 'utf8')), row)
    } catch {
      allMetadataMatches = false
    }
  }
  check('metadata.json and SQLite remain aligned after retention', allMetadataMatches)

  // The lock prevents a second live writer.
  const competing = new HistorySegmentStore({ rootDir: root, index, now: clock })
  let locked = false
  try {
    await competing.start()
  } catch {
    locked = true
  }
  check('single-instance lock rejects a competing store', locked)
  await restarted.close()
  await competing.start()
  check('lock is released on close', competing.health().state === 'healthy')
  await competing.close()
} finally {
  await rm(root, { recursive: true, force: true })
}

// A replacement store must wait for the previous lifecycle gate before taking
// the lock. This is the pause/resume boundary used by screenwatch.
const gatedRoot = await mkdtemp(join(tmpdir(), 'guzi-history-gated-'))
try {
  const gatedIndex = makeIndex()
  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const gated = new HistorySegmentStore({ rootDir: gatedRoot, index: gatedIndex, startAfter: gate })
  let settled = false
  const startPromise = gated.start().then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  check('replacement store waits for prior close lifecycle', !settled)
  releaseGate()
  await startPromise
  check('replacement store starts after lifecycle gate', gated.health().state === 'healthy')
  await gated.close()
} finally {
  await rm(gatedRoot, { recursive: true, force: true })
}

// SQLite index smoke test. Some host Node builds have a different native ABI;
// the main type/runtime build still exercises this adapter under Electron.
try {
  const { default: Database } = await import('better-sqlite3')
  const { createSqliteHistorySegmentIndex } = await import('../src/main/history/segment-index.ts')
  const db = new Database(':memory:')
  const sqliteIndex = createSqliteHistorySegmentIndex(db)
  sqliteIndex.upsert({
    id: 'sqlite-1',
    bucketStart: '2026-08-22T12:00:00.000Z',
    bucketEnd: '2026-08-22T12:10:00.000Z',
    eventsPath: 'segments/path/events.jsonl',
    eventCount: 1,
    meaningfulEventCount: 1,
    suppressedEventCount: 0,
    summaryStatus: 'pending',
    summaryText: null,
    summaryJson: null,
    retentionExpiresAt: '2026-08-24T12:10:00.000Z',
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-22T12:01:00.000Z'
  })
  check('SQLite segment index round-trips metadata', sqliteIndex.get('sqlite-1')?.eventCount === 1 && sqliteIndex.count() === 1)
  sqliteIndex.remove('sqlite-1')
  check('SQLite segment index removes metadata', sqliteIndex.count() === 0)
  db.close()
} catch (error) {
  console.log(`! SQLite adapter smoke skipped: ${error instanceof Error ? error.message : String(error)}`)
}

console.log(failed ? `\n${failed} history checks failed` : '\nAll history checks passed')
process.exit(failed ? 1 : 0)

// A disk write failure must cross the save barrier; closing still releases the lock.
{
  const root = await mkdtemp(join(tmpdir(), 'guzi-history-exit-'))
  const rows = new Map()
  const index = { upsert: (row) => rows.set(row.id, row), list: () => [...rows.values()],
    get: (id) => rows.get(id), remove: (id) => rows.delete(id), count: () => rows.size }
  const store = new HistorySegmentStore({ rootDir: root, index, now: () => NOW })
  try {
    store.append(event({ id: 'before-disk-failure' }))
    await store.flush()
    const path = join(root, [...rows.values()][0].eventsPath)
    const original = await readFile(path)
    await rm(path)
    await mkdir(path)
    store.append(event({ id: 'pending-disk-failure' }))
    let rejected = false
    try { await store.flush() } catch { rejected = true }
    check('exit flush propagates disk write failure', rejected)
    await rm(path, { recursive: true })
    await writeFile(path, original)
    await store.flush()
    check('exit save retries the retained event after disk recovery', (await readFile(path, 'utf8')).includes('pending-disk-failure'))
    await rm(path)
    await mkdir(path)
    store.append(event({ id: 'close-disk-failure' }))
    rejected = false
    try { await store.close() } catch { rejected = true }
    check('close reports the flush failure and releases its lock', rejected && !await readFile(join(root, '.lock')).then(() => true, () => false))
  } finally { await rm(root, { recursive: true, force: true }) }
}
