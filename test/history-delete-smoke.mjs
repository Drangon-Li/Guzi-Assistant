import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistorySegmentStore } from '../src/main/history/event-store.ts'
import Database from 'better-sqlite3'
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

// End-to-end artifact boundary: a full History clear removes every History artifact.
// 工作记录只从时间线派生，随区间一起由 deleteActivityHistoryRange 删除（见文件末尾的源码断言）。
const integratedRoot = await mkdtemp(join(tmpdir(), 'guzi-history-delete-integrated-'))
const integratedDb = new Database(':memory:')
try {
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
  const deletedSegmentIds = await integratedStore.clear()
  for (const id of summaryIndex.list().map((row) => row.id)) summaryIndex.remove(id)
  await integratedStore.close()

  await assert.rejects(access(eventsPath))
  await assert.rejects(access(metadataPath))
  assert.deepEqual(deletedSegmentIds, [segment.id])
  assert.equal(segmentIndex.count(), 0)
  assert.equal(summaryIndex.count(), 0)
  console.log('✓ full History clear removes JSONL, metadata, segment index and summaries')
} finally {
  integratedDb.close()
  await rm(integratedRoot, { recursive: true, force: true })
}

const historyServiceSource = readFileSync(new URL('../src/main/history/service.ts', import.meta.url), 'utf8')
assert.match(historyServiceSource, /for \(const id of summaryIds\) summaryIndex\.remove\(id\)/)
assert.equal((historyServiceSource.match(/const workRecordIds = deleteActivityHistoryRange\(fromMs, toMs\)/g) ?? []).length, 2)
console.log('✓ range delete and full clear both remove summary rows and the timeline work records in range')

function check(path) {
  assert.ok(path, 'segment path exists')
}
