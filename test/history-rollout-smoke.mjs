import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRolloutComparison } from '../src/main/history/rollout-comparison.ts'

const dbSource = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
assert.match(dbSource, /SELECT \* FROM activity_segments WHERE bucket_kind = '10m'/)
assert.match(dbSource, /WHERE activity_segments\.bucket_end IS NOT excluded\.bucket_end[\s\S]*activity_segments\.event_count IS NOT excluded\.event_count/)

const nowMs = Date.parse('2026-08-22T12:00:00.000Z')
const inRange = (start, end, extra = {}) => ({
  id: `${start}-${end}`,
  bucketStart: start,
  bucketEnd: end,
  eventCount: 2,
  meaningfulEventCount: 1,
  ...extra
})

const comparison = buildRolloutComparison({
  nowMs,
  retentionMs: 48 * 60 * 60 * 1000,
  legacySegments: [
    inRange('2026-08-22T10:00:00.000Z', '2026-08-22T10:10:00.000Z', { bucketKind: '10m', summary: 'local' }),
    inRange('2026-08-22T10:10:00.000Z', '2026-08-22T10:20:00.000Z', { bucketKind: '10m', summary: 'local' }),
    // The legacy table also stores a 6-hour aggregate for the same events.
    // It must not inflate the 10-minute rollout baseline.
    inRange('2026-08-22T06:00:00.000Z', '2026-08-22T12:00:00.000Z', { bucketKind: '6h', eventCount: 200, meaningfulEventCount: 100, summary: 'rollup' }),
    inRange('2026-08-20T00:00:00.000Z', '2026-08-20T00:10:00.000Z', { summary: 'expired' })
  ],
  historySegments: [
    inRange('2026-08-22T10:00:00.000Z', '2026-08-22T10:10:00.000Z', { suppressedEventCount: 3 }),
    inRange('2026-08-22T10:10:00.000Z', '2026-08-22T10:20:00.000Z', { suppressedEventCount: 1 })
  ],
  summaries: [
    { id: 'ten', level: '10m', bucketStart: '2026-08-22T10:00:00.000Z', bucketEnd: '2026-08-22T10:10:00.000Z', sourceSegmentIds: [] },
    { id: 'six', level: '6h', bucketStart: '2026-08-22T06:00:00.000Z', bucketEnd: '2026-08-22T12:00:00.000Z', sourceSegmentIds: [] },
    { id: 'expired', level: '10m', bucketStart: '2026-08-20T00:00:00.000Z', bucketEnd: '2026-08-20T00:10:00.000Z', sourceSegmentIds: [] }
  ],
  workRecords: [
    { id: 'legacy-1', derivedBy: 'legacy', app: 'Code', task: 'History', content: '编辑 History', startAt: '2026-08-22T10:00:00.000Z', endAt: '2026-08-22T10:05:00.000Z' },
    { id: 'legacy-2', derivedBy: 'legacy', app: 'Code', task: 'History', content: '编辑 History', startAt: '2026-08-22T10:00:00.000Z', endAt: '2026-08-22T10:05:00.000Z' },
    { id: 'history-1', derivedBy: 'history', segmentId: 'history-10m-2026-08-22T10:00:00.000Z', app: 'Code', task: 'History', content: '编辑 History', startAt: '2026-08-22T10:00:00.000Z', endAt: '2026-08-22T10:05:00.000Z' },
    { id: 'history-2', derivedBy: 'history', segmentId: 'history-10m-2026-08-22T10:10:00.000Z', app: 'Code', task: 'History', content: '编辑 History', startAt: '2026-08-22T10:10:00.000Z', endAt: '2026-08-22T10:15:00.000Z' }
  ]
})

assert.equal(comparison.schemaVersion, 1)
assert.equal(comparison.legacy.segmentCount, 2)
assert.equal(comparison.legacy.eventCount, 4)
assert.equal(comparison.legacy.meaningfulEventCount, 2)
assert.equal(comparison.legacy.tenMinuteSummaryCount, 2)
assert.equal(comparison.history.eventCount, 4)
assert.equal(comparison.history.suppressedEventCount, 4)
assert.equal(comparison.history.summaryCount, 2)
assert.equal(comparison.history.tenMinuteSummaryCount, 1)
assert.equal(comparison.history.sixHourSummaryCount, 1)
assert.equal(comparison.workRecords.legacyCount, 2)
assert.equal(comparison.workRecords.historyCount, 2)
assert.equal(comparison.workRecords.legacyDuplicateCount, 1)
assert.equal(comparison.workRecords.historyDuplicateCount, 0)
assert.equal(comparison.workRecords.crossPathOverlapCount, 1)
assert.equal(comparison.workRecords.legacyDuplicateRate, 0.5)
assert.equal(comparison.workRecords.historyDuplicateRate, 0)
assert.ok(!JSON.stringify(comparison).includes('编辑 History'))
console.log('✓ rollout comparison is bounded, aggregate-only, and retention-aware')
console.log('✓ event, summary, work-record counts and duplicate rates are comparable')
console.log('\nHistory rollout checks passed')
