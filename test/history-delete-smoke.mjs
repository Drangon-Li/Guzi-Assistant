import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistorySegmentStore } from '../src/main/history/event-store.ts'
import Database from 'better-sqlite3'
import { migrateWorkRecords } from '../src/main/db-migrations.ts'
import { createSqliteHistorySegmentIndex } from '../src/main/history/segment-index.ts'
import { createSqliteHistorySummaryIndex } from '../src/main/history/summary-index.ts'

const now = Date.parse('2026-08-22T12:00:00.000Z')
const root = await mkdtemp(join(tmpdir(), 'guzi-history-delete-'))
const rows = new Map()
const index = {
  upsert(row) { rows.set(row.id, structuredClone(row)) },
  remove(id) { rows.delete(id) },
  get(id) { return rows.get(id) ? structuredClone(rows.get(id)) : null },
  list() { return [...rows.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)).map((row) => structuredClone(row)) },
  count() { return rows.size }
}
const event = (id, at) => ({
  id,
  occurredAtMs: Date.parse(at),
  kind: 'click',
  source: 'collector',
  appName: 'Code',
  bundleId: 'com.microsoft.VSCode',
  windowTitle: `${id}.ts`,
  privacyState: 'normal'
})

try {
  const store = new HistorySegmentStore({ rootDir: root, index, now: () => now })
  await store.start()
  store.append(event('first', '2026-08-22T10:01:00.000Z'))
  store.append(event('second', '2026-08-22T10:21:00.000Z'))
  await store.flush()
  const first = index.list()[0]
  const second = index.list()[1]
  const firstPath = join(root, first.eventsPath)
  check(firstPath)
  const deleted = await store.deleteRange(Date.parse('2026-08-22T10:00:00.000Z'), Date.parse('2026-08-22T10:10:00.000Z'))
  assert.deepEqual(deleted, [first.id])
  await assert.rejects(access(firstPath))
  assert.equal(index.get(first.id), null)
  assert.equal(index.get(second.id)?.eventCount, 1)
  const secondBody = await readFile(join(root, second.eventsPath), 'utf8')
  assert.match(secondBody, /second/)
  const allDeleted = await store.clear()
  assert.deepEqual(allDeleted, [second.id])
  assert.equal(index.count(), 0)
  await store.close()
  console.log('✓ range deletion removes JSONL, metadata and index atomically')
  console.log('✓ clear removes remaining segments')
  console.log('\nHistory delete checks passed')
} finally {
  await rm(root, { recursive: true, force: true })
}

// End-to-end artifact boundary: a full History clear removes every History
// artifact while leaving an old OCR/legacy work record untouched.
const integratedRoot = await mkdtemp(join(tmpdir(), 'guzi-history-delete-integrated-'))
const integratedDb = new Database(':memory:')
try {
  integratedDb.exec(`
    CREATE TABLE work_records (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      app TEXT,
      task TEXT,
      evidence_source TEXT NOT NULL DEFAULT 'ocr',
      segment_id TEXT,
      start_at TEXT,
      end_at TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      summary_hash TEXT,
      derived_by TEXT NOT NULL DEFAULT 'legacy',
      created_at TEXT NOT NULL
    );
  `)
  migrateWorkRecords(integratedDb)
  const segmentIndex = createSqliteHistorySegmentIndex(integratedDb)
  const summaryIndex = createSqliteHistorySummaryIndex(integratedDb)
  const integratedStore = new HistorySegmentStore({ rootDir: integratedRoot, index: segmentIndex, now: () => now })
  await integratedStore.start()
  integratedStore.append(event('history-event', '2026-08-22T10:01:00.000Z'))
  await integratedStore.flush()
  const segment = segmentIndex.list()[0]
  const eventsPath = join(integratedRoot, segment.eventsPath)
  const metadataPath = eventsPath.replace(/events\.jsonl$/, 'metadata.json')
  summaryIndex.upsert({
    id: 'history-10m-2026-08-22T10:00:00.000Z',
    level: '10m',
    bucketStart: '2026-08-22T10:00:00.000Z',
    bucketEnd: '2026-08-22T10:10:00.000Z',
    sourceSegmentIds: [segment.id],
    sourceHash: 'delete-hash',
    status: 'ready',
    summaryText: 'local summary',
    summaryJson: JSON.stringify({ schemaVersion: 1, level: '10m', id: segment.id, summary: 'local summary', sourceSegmentIds: [segment.id] }),
    modelStatus: 'idle',
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
    createdAt: '2026-08-22T10:10:00.000Z',
    updatedAt: '2026-08-22T10:10:00.000Z'
  })
  integratedDb.prepare(`
    INSERT INTO work_records (
      id, content, app, task, evidence_source, segment_id, start_at, end_at,
      confidence, evidence_count, summary_hash, derived_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-ocr-keep', '旧 OCR 记录', 'Preview', null, 'ocr', null,
    '2026-08-22T10:01:00', '2026-08-22T10:01:00', 0.5, 1, null, 'legacy', '2026-08-22T10:01:00'
  )
  integratedDb.prepare(`
    INSERT INTO work_records (
      id, content, app, task, evidence_source, segment_id, start_at, end_at,
      confidence, evidence_count, summary_hash, derived_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'history-derived-delete', 'History 派生记录', 'Code', 'History', 'accessibility', segment.id,
    '2026-08-22T10:01:00', '2026-08-22T10:09:00', 0.8, 2, 'delete-hash', 'history', '2026-08-22T10:09:00'
  )

  const deletedSegmentIds = await integratedStore.clear()
  for (const id of summaryIndex.list().map((row) => row.id)) summaryIndex.remove(id)
  integratedDb.prepare("DELETE FROM work_records WHERE derived_by = 'history' AND segment_id = ?").run(segment.id)
  await integratedStore.close()

  await assert.rejects(access(eventsPath))
  await assert.rejects(access(metadataPath))
  assert.deepEqual(deletedSegmentIds, [segment.id])
  assert.equal(segmentIndex.count(), 0)
  assert.equal(summaryIndex.count(), 0)
  assert.equal(integratedDb.prepare("SELECT count(*) AS n FROM work_records WHERE derived_by = 'history'").get().n, 0)
  assert.equal(integratedDb.prepare("SELECT count(*) AS n FROM work_records WHERE derived_by = 'legacy'").get().n, 1)
  console.log('✓ full History clear removes JSONL, metadata, segment index, summaries, and derived work records')
  console.log('✓ full History clear preserves legacy OCR work records')
} finally {
  integratedDb.close()
  await rm(integratedRoot, { recursive: true, force: true })
}

const screenwatchSource = readFileSync(new URL('../src/main/screenwatch.ts', import.meta.url), 'utf8')
assert.match(screenwatchSource, /for \(const id of summaryIds\) summaryIndex\.remove\(id\)/)
assert.match(screenwatchSource, /removeHistoryWorkRecords\(/)
assert.match(screenwatchSource, /segmentIdsFromSummaries\.filter\(\(segmentId\) => segmentIdsInRange\.has\(segmentId\)\)/)
console.log('✓ runtime deletion removes summary rows and scopes derived-work deletion to the requested range')

function check(path) {
  assert.ok(path, 'segment path exists')
}
