import assert from 'node:assert/strict'
import { HistoryQueryService } from '../src/main/history/query-service.ts'

const NOW = Date.parse('2026-08-22T12:00:00.000Z')
const check = (name, value) => {
  console.log(`${value ? '✓' : '✗'} ${name}`)
  assert.ok(value, name)
}

function summary(id, level, start, text, extra = {}) {
  const end = new Date(Date.parse(start) + (level === '6h' ? 6 : 10) * 60 * 1000).toISOString()
  return {
    id,
    level,
    bucketStart: start,
    bucketEnd: end,
    sourceSegmentIds: [id],
    sourceHash: `hash-${id}`,
    status: 'ready',
    summaryText: text,
    summaryJson: JSON.stringify({
      schemaVersion: 1,
      level,
      id,
      bucketStart: start,
      bucketEnd: end,
      startAt: start,
      endAt: end,
      timeRange: { startAt: start, endAt: end },
      apps: extra.apps ?? ['Code'],
      appStats: [],
      windowThemes: extra.windowThemes ?? ['history.ts'],
      activityTypes: extra.activityTypes ?? ['click'],
      activityTypeCounts: extra.activityTypeCounts ?? [{ type: 'click', count: 4 }],
      taskClues: extra.taskClues ?? ['Computer History'],
      focusTask: extra.focusTask ?? null,
      confidence: 0.84,
      evidenceCount: 3,
      meaningfulEvidenceCount: 3,
      sourceSegmentIds: [id],
      sourceSegments: [id],
      source: 'local',
      summary: text,
      observedData: [{ window: 'must not be returned' }],
      suppressedEventCount: 2
    }),
    modelStatus: 'idle',
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
    createdAt: start,
    updatedAt: end
  }
}

const rows = [
  summary('history-6h-2026-08-22T06:00:00.000Z', '6h', '2026-08-22T06:00:00.000Z', '上午研究计划汇总 password=secret', {
    taskClues: ['研究计划'],
    focusTask: '研究计划'
  }),
  summary('history-10m-2026-08-22T10:00:00.000Z', '10m', '2026-08-22T10:00:00.000Z', '编辑 History 查询服务', {
    taskClues: ['History 查询']
  })
]
const segment = {
  metadata: {
    id: 'history-10m-2026-08-22T11:00:00.000Z',
    bucketStart: '2026-08-22T11:00:00.000Z',
    bucketEnd: '2026-08-22T11:10:00.000Z',
    eventsPath: 'segments/x/events.jsonl',
    eventCount: 2,
    meaningfulEventCount: 2,
    suppressedEventCount: 4,
    summaryStatus: 'pending',
    summaryText: null,
    summaryJson: null,
    retentionExpiresAt: '2026-08-24T11:10:00.000Z',
    createdAt: '2026-08-22T11:00:00.000Z',
    updatedAt: '2026-08-22T11:09:00.000Z'
  },
  events: [
    {
      id: 'e1',
      occurred_at: '2026-08-22T11:01:00.000Z',
      kind: 'click',
      source: 'collector',
      app_name: 'Safari',
      bundle_id: 'com.apple.Safari',
      window_title: '论文修改',
      url_host: 'example.test',
      target_role: 'button',
      target_label: '保存',
      command: 'pointer_action',
      modifiers: [],
      input_length: null,
      secure_input: false,
      privacy_state: 'normal',
      suppressed: false
    }
  ]
}

const summaryIndex = {
  list(level) {
    return rows.filter((row) => !level || row.level === level)
  },
  count(level) { return this.list(level).length },
  get(id) { return rows.find((row) => row.id === id) ?? null },
  upsert() {},
  remove() {}
}
const segmentIndex = { list: () => [segment.metadata], count: () => 1, get: () => segment.metadata, upsert() {}, remove() {} }
let listSnapshotsCalls = 0
const store = {
  async listSegmentSnapshots() { listSnapshotsCalls += 1; return [segment] },
  async readSegmentSnapshot() { return segment }
}
let paused = false
const service = new HistoryQueryService({
  summaryIndex,
  segmentIndex,
  getStore: async () => store,
  getStatus: () => ({
    enabled: true,
    paused,
    health: {
      enabled: true,
      state: 'healthy',
      currentSegmentId: segment.metadata.id,
      queueLength: 0,
      droppedCount: 0,
      suppressedCount: 4,
      invalidCount: 0,
      segmentCount: 1,
      lastWriteAt: segment.metadata.updatedAt,
      lastCleanupAt: null,
      lastError: null
    },
    retentionExpiresAt: segment.metadata.retentionExpiresAt,
    summaryCounts: { tenMinute: 1, sixHour: 1 }
  }),
  summarize: async () => ({ tenMinuteSummaries: 1, sixHourSummaries: 1, modelSuccesses: 0, modelFailures: 0 }),
  pause: async () => { paused = true; return service.status() },
  resume: async () => { paused = false; return service.status() },
  deleteRange: async (from, to) => ({
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    deletedSegmentIds: [segment.metadata.id],
    deletedSummaryIds: [],
    deletedWorkRecordIds: []
  }),
  clear: async () => ({ range: null, deletedSegmentIds: [], deletedSummaryIds: [], deletedWorkRecordIds: [] }),
  now: () => NOW
})

const recent = await service.recent({ from: '2026-08-22T05:00:00.000Z', to: '2026-08-22T12:00:00.000Z' })
check('recent query returns six-hour before ten-minute summaries', recent.sixHour[0]?.level === '6h' && recent.tenMinute[0]?.level === '10m')
check('summary projection exposes event type counts', recent.sixHour[0]?.activityTypeCounts[0]?.type === 'click' && recent.sixHour[0]?.activityTypeCounts[0]?.count === 4)
check('summary projection exposes the shared focus task', recent.sixHour[0]?.focusTask === '研究计划')
check('uncovered segment is used as a safe aggregate fallback', recent.segments[0]?.id === segment.metadata.id && recent.fallbackUsed)
check('segment fallback exposes event type counts', recent.segments[0]?.activityTypeCounts[0]?.type === 'click' && recent.segments[0]?.activityTypeCounts[0]?.count === 1)
check('query projection omits observed raw data', !Object.hasOwn(recent.tenMinute[0], 'observedData') && !JSON.stringify(recent).includes('must not be returned'))
check('query projection redacts sensitive summary text', !JSON.stringify(recent).includes('password=secret') && JSON.stringify(recent).includes('[已隐去·凭据]'))
check('segment fallback omits labels and commands', !JSON.stringify(recent.segments).includes('保存') && !JSON.stringify(recent.segments).includes('pointer_action'))

const originalSixHourJson = rows[0].summaryJson
const sixHourDocument = JSON.parse(originalSixHourJson)
sixHourDocument.sourceSegmentIds = [segment.metadata.id]
rows[0].summaryJson = JSON.stringify(sixHourDocument)
const coveredRecent = await service.recent({ from: '2026-08-22T05:00:00.000Z', to: '2026-08-22T12:00:00.000Z' })
check('six-hour coverage avoids duplicate raw segment fallback', coveredRecent.segments.length === 0)
check('covered summaries avoid a full raw segment scan', listSnapshotsCalls === 0)
rows[0].summaryJson = originalSixHourJson

const search = await service.search({ query: '论文修改', from: '2026-08-22T10:30:00.000Z', to: '2026-08-22T11:30:00.000Z' })
check('search falls back to raw segment matching when summary is absent', search.segments[0]?.id === segment.metadata.id && search.fallbackUsed)
check('search still does not return raw event fields', !JSON.stringify(search.segments).includes('论文修改'))
check('pause and resume delegate to runtime', (await service.pause()).paused && !(await service.resume()).paused)
check('summary trigger returns run counters', (await service.summarize()).run.tenMinuteSummaries === 1)
check('delete range validates and delegates normalized timestamps', (await service.deleteRange({ from: '2026-08-22T11:00:00.000Z', to: '2026-08-22T11:10:00.000Z' })).deletedSegmentIds.length === 1)
assert.throws(() => service.deleteRange({}), /explicit from and to/)
check('delete range requires explicit bounds', true)

console.log('\nHistory query checks passed')
