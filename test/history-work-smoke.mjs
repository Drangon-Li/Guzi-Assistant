import { readFileSync } from 'node:fs'
import {
  deriveHistoryWorkRecord
} from '../src/main/history/work-derivation.ts'
import { HistorySummarizer } from '../src/main/history/summarizer.ts'
import { focusDurations, groupWorkPeriods } from '../src/shared/work-report.ts'
import { productiveRuns } from '../src/shared/attention.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed += 1
}

const document = {
  schemaVersion: 1,
  level: '10m',
  id: 'history-10m-2026-08-22T10:00:00.000Z',
  bucketStart: '2026-08-22T10:00:00.000Z',
  bucketEnd: '2026-08-22T10:10:00.000Z',
  startAt: '2026-08-22T10:01:12.000Z',
  endAt: '2026-08-22T10:09:42.000Z',
  timeRange: { startAt: '2026-08-22T10:01:12.000Z', endAt: '2026-08-22T10:09:42.000Z' },
  apps: ['Code'],
  appStats: [],
  windowThemes: ['work-derivation.ts'],
  activityTypes: ['click'],
  activityTypeCounts: [{ type: 'click', count: 4 }],
  taskClues: ['开发谷子助手'],
  focusTask: '开发谷子助手',
  confidence: 0.82,
  evidenceCount: 4,
  meaningfulEvidenceCount: 4,
  sourceSegmentId: 'history-10m-2026-08-22T10:00:00.000Z',
  sourceSegmentIds: ['history-10m-2026-08-22T10:00:00.000Z'],
  sourceSegments: ['history-10m-2026-08-22T10:00:00.000Z'],
  source: 'local',
  summary: '编辑项目代码',
  observedData: [],
  suppressedEventCount: 0
}

const derived = deriveHistoryWorkRecord(document, 'source-hash-1')
check(
  '摘要派生记录携带 segment、区间、置信度和证据数',
  derived?.segmentId === document.sourceSegmentId &&
    derived.startAt === document.startAt &&
    derived.endAt === document.endAt &&
    derived.confidence === 0.82 &&
    derived.evidenceCount === 4
)
check('摘要派生记录保留 App、任务线索和摘要内容',
  derived?.app === 'Code' && derived.task === '开发谷子助手' && derived.content === '编辑项目代码')
check('工作记录 task 使用摘要的稳定 focusTask，而不是第一条线索',
  deriveHistoryWorkRecord({ ...document, focusTask: '开发谷子助手', taskClues: ['窗口标题：work-derivation.ts'] }, 'source-hash-1')?.task === '开发谷子助手')
check('无法确认任务时不把泛化焦点写入 task',
  deriveHistoryWorkRecord({ ...document, focusTask: null, focus: '处理当前内容', taskClues: ['窗口标题'] }, 'source-hash-1')?.task === null)
check('同一 segment/source hash 计算稳定',
  derived?.summaryHash === deriveHistoryWorkRecord(document, 'source-hash-1')?.summaryHash)
check('摘要内容变化会产生新的 hash',
  derived?.summaryHash !== deriveHistoryWorkRecord({ ...document, summary: '排查构建错误' }, 'source-hash-1')?.summaryHash)
check('suppressed-only 摘要不生成工作记录',
  deriveHistoryWorkRecord({ ...document, meaningfulEvidenceCount: 0, evidenceCount: 0 }, 'source-hash-1') === null)
check('六小时摘要不会直接派生工作记录',
  deriveHistoryWorkRecord({ ...document, level: '6h' }, 'source-hash-1') === null)

const historyRecord = (id, startAt, endAt, task = '开发谷子助手') => ({
  id,
  content: '编辑项目代码',
  app: 'Code',
  task,
  source: 'accessibility',
  derivedBy: 'history',
  segmentId: id,
  startAt,
  endAt,
  confidence: 0.8,
  evidenceCount: 3,
  summaryHash: `hash-${id}`,
  createdAt: endAt
})

const intervalRecords = [
  historyRecord('s1', '2026-08-22T10:00:00', '2026-08-22T10:10:00'),
  historyRecord('s2', '2026-08-22T10:12:00', '2026-08-22T10:20:00')
]
const period = groupWorkPeriods(intervalRecords)[0]
check('工作时段按真实 startAt/endAt 合并',
  period?.start.endsWith('10:00:00') && period.end.endsWith('10:20:00') && period.durationSeconds === 1200)
check('同一 App 内不同任务分开',
  groupWorkPeriods([
    historyRecord('task-a', '2026-08-22T11:00:00', '2026-08-22T11:05:00', '任务 A'),
    historyRecord('task-b', '2026-08-22T11:06:00', '2026-08-22T11:10:00', '任务 B')
  ]).length === 2)
check('任务专注时长不再给 History 单条固定加 1 分钟',
  focusDurations([historyRecord('single', '2026-08-22T10:00:00', '2026-08-22T10:00:00')])[0]?.seconds === 0)
check('任务专注时长使用真实区间', focusDurations(intervalRecords)[0]?.seconds === 1200)
check('生产力专注段使用真实区间',
  productiveRuns(intervalRecords, () => 'productive')[0]?.seconds === 1200)

const snapshot = {
  metadata: {
    id: document.id,
    bucketStart: document.bucketStart,
    bucketEnd: document.bucketEnd,
    eventCount: 1,
    meaningfulEventCount: 1,
    suppressedEventCount: 0,
    summaryStatus: 'pending',
    summaryText: null,
    summaryJson: null,
    retentionExpiresAt: '2026-08-24T10:10:00.000Z',
    createdAt: document.bucketStart,
    updatedAt: document.endAt
  },
  events: [{
    id: 'event-1',
    occurred_at: document.startAt,
    kind: 'click',
    source: 'collector',
    app_name: 'Code',
    bundle_id: 'com.microsoft.VSCode',
    window_title: 'work-derivation.ts',
    url_host: null,
    target_role: 'button',
    target_label: null,
    command: 'pointer_action',
    modifiers: [],
    input_length: null,
    secure_input: false,
    privacy_state: 'normal',
    suppressed: false
  }]
}
const summaryRows = new Map()
const summaryIndex = {
  upsert(row) { summaryRows.set(row.id, { ...row }) },
  remove(id) { summaryRows.delete(id) },
  get(id) { return summaryRows.get(id) ?? null },
  list(level) { return [...summaryRows.values()].filter((row) => !level || row.level === level) },
  count(level) { return this.list(level).length }
}
const store = {
  async listSegmentSnapshots() { return [snapshot] },
  async updateSummary() { return true },
  async close() {}
}
let callbackDocument = null
let callbackHash = null
const summarizer = new HistorySummarizer({
  store,
  summaryIndex,
  now: () => Date.parse('2026-08-22T10:20:00.000Z'),
  onlineEnabled: () => false,
  onTenMinuteSummary(next, hash) {
    callbackDocument = next
    callbackHash = hash
  }
})
await summarizer.process(Date.parse('2026-08-22T10:20:00.000Z'))
check('摘要器在 10 分钟摘要完成后触发派生回调', callbackDocument?.level === '10m' && typeof callbackHash === 'string')
await summarizer.close()

const screenwatch = readFileSync(new URL('../src/main/screenwatch.ts', import.meta.url), 'utf8')
const db = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
check('两个派生开关按 AND 关系独立回滚',
  /historyV2Enabled && settings\.historyDerivedWorkEnabled/.test(screenwatch) && /historyDerivedWorkEnabled !== undefined/.test(readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')))
check('旧 OCR 路径明确标记 legacy', /derivedBy: 'legacy'/.test(screenwatch) && /DEFAULT 'legacy'/.test(db))
check('语义不足的 hard fallback 保留旧 OCR 记录', /hard_fallback_incomplete/.test(screenwatch))
check('work_records 迁移包含 History 追溯字段',
  /segment_id TEXT/.test(db) && /start_at TEXT/.test(db) && /end_at TEXT/.test(db) && /summary_hash TEXT/.test(db) && /derived_by TEXT/.test(db))

console.log(failed ? `\n${failed} 项 history work checks failed` : '\nAll history work checks passed')
process.exit(failed ? 1 : 0)
