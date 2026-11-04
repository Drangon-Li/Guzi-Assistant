import assert from 'node:assert/strict'
import { ActivityTimeline, activityUsage } from '../src/shared/activity-timeline.ts'
import { focusDurations, groupWorkPeriods, workRecordInterval } from '../src/shared/work-report.ts'
import { productiveRunsFromSwitches } from '../src/shared/attention.ts'

const base = new Date(2026, 9, 18, 9).getTime()
function replay(events) {
  const engine = new ActivityTimeline('demo')
  const rows = new Map()
  for (const event of events) {
    for (const row of engine.observe({ atMs: base + event[0], monotonicMs: event[0], state: 'active',
      appName: 'A', historyAllowed: true, ...event[1] })) rows.set(row.id, row)
  }
  return [...rows.values()]
}
const seconds = (rows) => activityUsage(rows, -Infinity, Infinity).reduce((sum, row) => sum + row.seconds, 0)
let rows = replay([[0], [5_000], [10_000, { appName: 'B' }], [15_000], [20_000]])
assert.deepEqual(activityUsage(rows, base, base + 30_000), [{ app: 'A', seconds: 15 }, { app: 'B', seconds: 5 }])
console.log('✓ A → B → A，回到同一 App 仍保留独立区间，只有已确认 heartbeat 计时')
rows = replay([[0, { idleSeconds: 54 }], [5_000, { idleSeconds: 59 }], [6_000, { idleSeconds: 60 }], [7_000, { idleSeconds: 61 }]])
assert.equal(seconds(rows), 6)
assert.deepEqual(rows.map((r) => r.state), ['active', 'idle'])
console.log('✓ idle 59/60/61 秒阈值：59 秒活跃，60 秒开始 idle，61 秒不补记')
for (const state of ['locked', 'suspended', 'paused', 'unknown']) {
  rows = replay([[0], [5_000], [8_000, { state, reason: state }], [3_600_000, { state: 'unknown' }], [3_601_000], [3_606_000]])
  assert.equal(seconds(rows), 10, state)
}
console.log('✓ 锁屏、睡眠、暂停、失联切段；恢复不补离线时长')
rows = replay([[0], [5_000], [10_000, { state: 'unknown', reason: 'stop' }]])
assert.equal(seconds(rows), 5)
assert.equal(rows.find((r) => r.state === 'active').endReason, 'stop')
rows = replay([[0], [5_000], [10_000]])
assert.equal(seconds(rows), 10)
console.log('✓ stop只结算最新确认heartbeat；首个App一直不切换也有时长')
rows = replay([[0], [5_000], [5_000], [3_600_000], [3_605_000]])
assert.equal(seconds(rows), 10)
console.log('✓ 重复heartbeat幂等；collector一小时失联不桥接')
rows = replay([[0], [5_000], [10_000, { atMs: base - 60_000 }], [15_000], [20_000]])
assert.equal(seconds(rows), 10)
rows = replay([[0], [5_000], [10_000, { atMs: base + 3_600_000 }], [15_000, { atMs: base + 3_605_000 }]])
assert.equal(seconds(rows), 10)
console.log('✓ 墙钟前跳/后跳都切段，不累计跳变时间或重叠区间')
{
  const engine = new ActivityTimeline('midnight')
  const midnight = new Date(2026, 9, 19).getTime()
  const snapshots = new Map()
  for (const t of [-5_000, 0, 5_000]) for (const row of engine.observe({ atMs: midnight + t, monotonicMs: t, state: 'active', appName: 'A' })) snapshots.set(row.id, row)
  assert.equal(seconds([...snapshots.values()]), 10)
  assert.equal(activityUsage([...snapshots.values()], midnight - 86_400_000, midnight)[0].seconds, 5)
  assert.equal(activityUsage([...snapshots.values()], midnight, midnight + 86_400_000)[0].seconds, 5)
}
console.log('✓ 跨本地午夜拆分，重复更新同一天区间不重算')
const record = (id, start, end, task = '任务A', activeMs) => ({ id, content: '编辑代码', app: 'A', task,
  source: 'ocr', derivedBy: 'timeline', createdAt: new Date(base + start).toISOString(),
  startAt: new Date(base + start).toISOString(), endAt: new Date(base + end).toISOString(), activeMs })
assert.equal(focusDurations([record('a', 0, 60_000), record('unknown', 60_000, 600_000, null), record('b', 600_000, 660_000)])[0].seconds, 120)
assert.equal(focusDurations([record('a', 0, 60_000), record('b', 600_000, 660_000)])[0].seconds, 120)
assert.equal(groupWorkPeriods([record('a', 0, 60_000), record('b', 600_000, 660_000)])[0].durationSeconds, 120)
assert.equal(focusDurations([record('a', 0, 60_000), record('dup', 0, 60_000)])[0].seconds, 60)
assert.equal(workRecordInterval(record('zero', 0, 0, '任务A', 0)).activeMs, 0)
assert.equal(focusDurations([record('zero', 0, 600_000, '任务A', 0)])[0].seconds, 0)
console.log('✓ A → 未分类 → A 和15分钟以内观察空隙不虚增；重复结果不重复计时；明确0时长合法')
assert.deepEqual(productiveRunsFromSwitches([{ ts: new Date(base).toISOString(), toApp: 'A', fromApp: null }], () => 'productive', 10, base + 86_400_000), [])
assert.equal(productiveRunsFromSwitches([{ ts: new Date(base).toISOString(), endTs: new Date(base + 5_000).toISOString(), activeMs: 5_000, toApp: 'A', fromApp: null }], () => 'productive')[0].seconds, 5)
console.log('✓ 末条switch不伸到现在')
