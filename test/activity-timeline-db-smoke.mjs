import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { posix, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import ts from 'typescript'

const Database = (await import('better-sqlite3')).default
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'guzi-activity-demo-'))
const modules = ['src/shared/parsing.ts', 'src/shared/work-report.ts', 'src/shared/activity-timeline.ts',
  'src/shared/semantic-work.ts', 'src/main/work-records.ts',
  'src/main/db-migrations.ts', 'src/main/db/activity-retention.ts', 'src/main/db/work-records.ts', 'src/main/db/activity-timeline.ts', 'src/main/db/app-usage.ts']
const stubs = {
  'src/main/db/connection.ts': 'export const getDb = () => globalThis.demoDb;',
  'src/main/db/settings.ts': 'export const getSettings = () => globalThis.demoSettings;',
  'src/main/db.ts': `export * from './db/work-records.ts'; export * from './db/app-usage.ts';
    export * from './db/settings.ts'; export const listFocusTaskCandidates = () => [];
    export const localDateTimeAt = (ms) => new Date(ms).toISOString();`,
  'src/main/parser.ts': 'export const cloudReady = () => false; export const parseToItemsRaw = () => { throw new Error("unexpected model invocation"); };',
  'src/main/activity-tracker.ts': 'export const setWorkClassificationStatus = () => {};',
  'src/main/history/service.ts': `export const historyDerivedWorkActive = () => false;
    export const getHistoryContentEpoch = () => 0; export const historyContentAllowed = () => true;`,
  'src/main/windows.ts': 'export const debugEvent = () => {};'

}
const allowed = new Set([...modules, ...Object.keys(stubs)])
function compile(name, source) {
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  code = code.replace(/(from\s*['"])([^'"]+)(['"])/g, (_, before, spec, after) => {
    if (!spec.startsWith('.') && !spec.startsWith('@shared/')) return before + spec + after
    let target = spec.startsWith('@shared/') ? `src/shared/${spec.slice(8)}` : posix.resolve('/', posix.dirname(name), spec).slice(1)
    if (!target.endsWith('.ts')) target += '.ts'
    assert.ok(allowed.has(target), `unexpected module ${target}`)
    return before + pathToFileURL(join(temp, target.replace(/\.ts$/, '.mjs'))).href + after
  })
  const path = join(temp, name.replace(/\.ts$/, '.mjs'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, code)
}
let db
try {
  for (const name of modules) compile(name, readFileSync(join(root, name), 'utf8'))
  for (const [name, source] of Object.entries(stubs)) compile(name, source)
  const load = (name) => import(pathToFileURL(join(temp, name.replace(/\.ts$/, '.mjs'))))
  const migrate = await load('src/main/db-migrations.ts')
  const timeline = await load('src/main/db/activity-timeline.ts')
  const usage = await load('src/main/db/app-usage.ts')
  const work = await load('src/main/db/work-records.ts')
  const legacyWork = await load('src/main/work-records.ts')
  const retention = await load('src/main/db/activity-retention.ts')
  const { focusDurations } = await load('src/shared/work-report.ts')
  db = globalThis.demoDb = new Database(':memory:')
  globalThis.demoSettings = { activityTimelineMode: 'shadow', activityTimelineCutoverAt: null }
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE work_records (id TEXT PRIMARY KEY, content TEXT, app TEXT, created_at TEXT);
    CREATE TABLE app_usage (day TEXT, app TEXT, seconds REAL, PRIMARY KEY(day, app));
    CREATE TABLE app_switches (ts TEXT, from_app TEXT, to_app TEXT);
    CREATE TABLE ocr_evidence (id TEXT PRIMARY KEY, occurred_at TEXT);`)
  migrate.migrateWorkRecords(db)
  migrate.migrateActivityTimeline(db)
  const day = '2026-10-18'
  const start = new Date(`${day}T09:00:00`).getTime()
  const i = { id: 'interval-1', sessionId: 'demo', startMs: start, endMs: start + 60_000,
    state: 'active', appName: 'Code', bundleId: 'com.code', historyAllowed: true, endReason: 'heartbeat' }
  timeline.persistActivityIntervals([i], start)
  timeline.persistActivityIntervals([i], start)
  assert.equal(timeline.listActivityIntervals(start, start + 600_000).length, 1)
  usage.addAppUsage(day, 'Code', 99)
  assert.equal(usage.appUsageSummary(day)[0].seconds, 99)
  assert.equal(timeline.compareActivityUsage(day).deltaSeconds, -39)
  globalThis.demoSettings.activityTimelineMode = 'unified'
  globalThis.demoSettings.activityTimelineCutoverAt = new Date(`${day}T00:00:00`).toISOString()
  assert.equal(usage.appUsageSummary(day)[0].seconds, 60)
  assert.equal(usage.appUsageRange(day, day)[0].seconds, 60)
  assert.equal(work.listWorkRecords(day)[0].activeMs, 60_000)
  assert.equal(work.listWorkRecords(day)[0].task, null)
  console.log('✓ SQLite真实domain：重复interval upsert幂等、shadow保持旧值、unified只读新区间、unknown不丢活动')
  const input = { segmentId: 'segment', content: '编辑代码', app: 'Code', task: '开发项目',
    startAt: new Date(start + 10_000).toISOString(), endAt: new Date(start + 40_000).toISOString(),
    activeMs: 30_000, intervalId: i.id, confidence: 0.8, evidenceCount: 1, summaryHash: 'hash' }
  const a = work.upsertTimelineWorkRecord(input)
  const b = work.upsertTimelineWorkRecord(input)
  assert.equal(a.id, b.id)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_records WHERE derived_by = 'timeline'").get().n, 1)
  let records = work.listWorkRecords(day)
  assert.deepEqual(records.map((r) => r.activeMs), [10_000, 30_000, 20_000])
  assert.equal(focusDurations(records)[0].seconds, 30)
  assert.equal(records.reduce((sum, r) => sum + r.activeMs, 0), 60_000)
  assert.equal(work.listWorkRecordsBetween(day, day).length, 3)
  console.log('✓ 部分语义投影扣除覆盖后补unknown；相同结果不重复计时，整日export完整')
  work.addWorkRecord({ content: '旧路径', app: 'Code', task: '开发项目', startAt: new Date(start).toISOString(),
    endAt: new Date(start + 60_000).toISOString(), createdAt: `${day}T09:00:00` })
  globalThis.demoSettings.activityTimelineMode = 'legacy'
  records = work.listWorkRecords(day)
  assert.equal(records.reduce((sum, r) => sum + (r.activeMs ?? 0), 0), 60_000)
  assert.equal(records.some((r) => r.derivedBy === 'timeline'), true)
  assert.equal(focusDurations(records)[0].seconds, 60)
  assert.equal(usage.appUsageSummary(day)[0].seconds, 99)
  console.log('✓ 回滚保留已派生timeline，旧record按重叠扣除，不重复累计且兼容App时长可读')
  timeline.persistActivityIntervals([{ ...i, id: 'excluded', startMs: start + 60_000, endMs: start + 120_000, historyAllowed: false }], start)
  assert.equal(timeline.continuousActivityEvidence(start + 60_000, start + 120_000, 'Code'), null)
  assert.equal(timeline.continuousActivityEvidence(start, start + 60_000, 'Code').activeMs, 60_000)
  assert.equal(timeline.continuousActivityEvidence(start, start + 3_600_000, 'Code'), null)
  globalThis.demoSettings.activityTimelineMode = 'unified'
  assert.equal(usage.appUsageSummary(day)[0].seconds, 120)
  assert.equal(timeline.compareActivityUsage(day).historyExcludedSeconds, 60)
  console.log('✓ History排除不影响Appusage授权；重复文字跨离线小时没有延伸证据')
  db.prepare('INSERT INTO ocr_evidence VALUES (?,?)').run('keep', new Date(start + 5_000).toISOString())
  db.prepare('INSERT INTO ocr_evidence VALUES (?,?)').run('delete', new Date(start + 25_000).toISOString())
  const beforeDelete = usage.appUsageSummary(day)[0].seconds
  const removed = retention.deleteActivityHistoryRange(start + 20_000, start + 30_000)
  assert.ok(removed.includes(a.id))
  assert.equal(usage.appUsageSummary(day)[0].seconds, beforeDelete)
  records = work.listWorkRecords(day)
  assert.equal(records.reduce((sum, row) => sum + row.activeMs, 0), 50_000)
  assert.equal(records.some((row) => Date.parse(row.startAt) < start + 30_000 && Date.parse(row.endAt) > start + 20_000), false)
  assert.equal(records.filter((row) => row.task === '开发项目').reduce((sum, row) => sum + row.activeMs, 0), 20_000)
  assert.deepEqual(db.prepare('SELECT id FROM ocr_evidence').all().map((r) => r.id), ['keep'])
  assert.equal(timeline.listActivityIntervals(start + 20_000, start + 30_000, { historyOnly: true }).length, 0)
  retention.deleteActivityHistoryRange(start + 20_000, start + 30_000)
  assert.equal(usage.appUsageSummary(day)[0].seconds, beforeDelete)
  console.log('✓ 范围删除拆分before/hidden/after，范围外语义保留、OCR按发生时刻删除、unknown不复活且usage不变')
  retention.clearActivityHistory()
  assert.equal(work.listWorkRecords(day).length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ocr_evidence').get().n, 0)
  assert.equal(usage.appUsageSummary(day)[0].seconds, beforeDelete)
  assert.equal(timeline.listActivityIntervals(start, start + 120_000, { historyOnly: true }).length, 0)
  console.log('✓ 清空History关闭全部历史授权、删除timeline/OCR；纯应用时长授权保持且unknown不会复活')
  const oldDay = '2025-01-01'
  globalThis.demoSettings.activityTimelineCutoverAt = new Date(`${oldDay}T00:00:00`).toISOString()
  usage.addAppUsage(oldDay, 'Code', 123)
  assert.equal(usage.appUsageSummary(oldDay)[0].seconds, 123)
  assert.equal(usage.appUsageRange(oldDay, oldDay)[0].seconds, 123)
  const oldStart = new Date(`${oldDay}T09:00:00`).getTime()
  work.upsertTimelineWorkRecord({ ...input, segmentId: 'expired', intervalId: 'expired-interval',
    startAt: new Date(oldStart).toISOString(), endAt: new Date(oldStart + 60_000).toISOString(), activeMs: 60_000 })
  assert.equal(work.listWorkRecords(oldDay)[0].activeMs, 60_000)
  retention.deleteActivityHistoryRange(oldStart + 20_000, oldStart + 30_000)
  assert.equal(work.listWorkRecords(oldDay).reduce((sum, row) => sum + row.activeMs, 0), 50_000)
  console.log('✓ 过90天interval留存仍读取兼容aggregate，work时长快照保留且仍可精确范围删除')
  const observed = start + 602_000
  const live = { ...i, id: 'legacy-repeat-heartbeat', startMs: observed - 2_000, endMs: observed + 58_000 }
  timeline.persistActivityIntervals([live], observed)
  const realNow = Date.now
  let modelReturnedAt = observed
  Date.now = () => modelReturnedAt
  try {
    legacyWork.resetWorkRecordThrottle()
    legacyWork.maybeAddWorkRecord('编辑持续观察回归代码', '持续观察回归', 'Code', 'ocr')
    const readLegacy = () => db.prepare("SELECT * FROM work_records WHERE content = '编辑持续观察回归代码' ORDER BY start_at").all()
    modelReturnedAt = observed + 61_000
    legacyWork.maybeAddWorkRecord('编辑持续观察回归代码', '持续观察回归', 'Code', 'ocr')
    assert.equal(readLegacy().length, 1)
    assert.equal(readLegacy()[0].active_ms, 58_000)
    assert.equal(Date.parse(readLegacy()[0].end_at), observed + 58_000)
    assert.deepEqual(timeline.continuousActivityEvidence(observed, modelReturnedAt, 'Code'), {
      intervalId: live.id, activeMs: 58_000, confirmedEndMs: observed + 58_000
    })
    modelReturnedAt = observed + 62_000
    legacyWork.maybeAddWorkRecord('编辑持续观察回归代码', '持续观察回归', 'Code', 'ocr')
    assert.equal(readLegacy()[0].active_ms, 58_000)
    timeline.persistActivityIntervals([{ ...live, endMs: observed + 118_000 }], modelReturnedAt)
    modelReturnedAt = observed + 121_000
    legacyWork.maybeAddWorkRecord('编辑持续观察回归代码', '持续观察回归', 'Code', 'ocr')
    assert.equal(readLegacy()[0].active_ms, 118_000)
    assert.equal(Date.parse(readLegacy()[0].end_at), observed + 118_000)
    assert.equal(timeline.continuousActivityEvidence(observed, observed + 129_000, 'Code'), null)
    console.log('✓ 真实OCR+SQLite：模型返回落后heartbeat 3秒仍延伸到确认端点；重复结果不计尾巴、不重复累计')
    timeline.persistActivityIntervals([
      { ...live, id: 'legacy-unknown', startMs: observed + 118_000, endMs: observed + 121_000, state: 'unknown', appName: null, historyAllowed: false },
      { ...live, id: 'legacy-after-unknown', startMs: observed + 121_000, endMs: observed + 178_000 }
    ], modelReturnedAt)
    modelReturnedAt = observed + 181_000
    legacyWork.maybeAddWorkRecord('编辑持续观察回归代码', '持续观察回归', 'Code', 'ocr')
    assert.equal(readLegacy().length, 2)
    assert.equal(readLegacy()[0].active_ms, 118_000)
    assert.equal(readLegacy()[1].active_ms, 0)
    for (const state of ['idle', 'unknown']) {
      const offset = state === 'idle' ? 300_000 : 400_000
      timeline.persistActivityIntervals([
        { ...live, id: `prefix-${state}`, startMs: observed + offset, endMs: observed + offset + 5_000 },
        { ...live, id: `break-${state}`, startMs: observed + offset + 5_000, endMs: observed + offset + 6_000, state, appName: null, historyAllowed: false },
        { ...live, id: `suffix-${state}`, startMs: observed + offset + 6_000, endMs: observed + offset + 10_000 }
      ], modelReturnedAt)
      assert.equal(timeline.continuousActivityEvidence(observed + offset, observed + offset + 10_000, 'Code'), null)
    }
    timeline.persistActivityIntervals([
      { ...live, id: 'prefix-gap', startMs: observed + 500_000, endMs: observed + 505_000 },
      { ...live, id: 'suffix-gap', startMs: observed + 510_000, endMs: observed + 515_000 }
    ], modelReturnedAt)
    assert.equal(timeline.continuousActivityEvidence(observed + 500_000, observed + 515_000, 'Code'), null)
    console.log('✓ 真实连续证据检查：未知、idle、collector缺口均不跨段；超过10秒未确认尾巴拒绝延伸')
  } finally { Date.now = realNow }

  const compareDay = '2026-10-17'
  const compareStart = new Date(`${compareDay}T09:00:00`).getTime()
  usage.addAppUsage(compareDay, 'Code', 27 * 60)
  assert.deepEqual(timeline.compareActivityUsage(compareDay), {
    comparable: false, comparisonFromMs: null, comparisonReason: 'baseline_missing',
    legacySeconds: 0, timelineSeconds: 0, deltaSeconds: 0, stateSeconds: {}, endReasons: {}, historyExcludedSeconds: 0
  })
  const comparedInterval = { ...i, id: 'compare-window', startMs: compareStart, endMs: compareStart }
  timeline.persistActivityIntervals([comparedInterval], compareStart)
  let comparison = timeline.compareActivityUsage(compareDay)
  assert.equal(comparison.comparable, true)
  assert.equal(comparison.comparisonFromMs, compareStart)
  assert.equal(comparison.legacySeconds, 0)
  assert.equal(comparison.timelineSeconds, 0)
  timeline.persistActivityIntervals([{ ...comparedInterval, endMs: compareStart + 5_000 }], compareStart + 5_000)
  usage.addAppUsage(compareDay, 'Code', 5)
  comparison = timeline.compareActivityUsage(compareDay)
  assert.equal(comparison.legacySeconds, 5)
  assert.equal(comparison.timelineSeconds, 5)
  assert.equal(comparison.deltaSeconds, 0)
  timeline.persistActivityIntervals([{ ...comparedInterval, endMs: compareStart + 5_000 }], compareStart + 5_000)
  assert.equal(timeline.compareActivityUsage(compareDay).deltaSeconds, 0)
  const afterRestart = { ...comparedInterval, id: 'compare-restart', startMs: compareStart + 10_000, endMs: compareStart + 15_000 }
  timeline.persistActivityIntervals([afterRestart], compareStart + 15_000)
  usage.addAppUsage(compareDay, 'Code', 5)
  assert.equal(timeline.compareActivityUsage(compareDay).comparisonFromMs, compareStart)
  assert.equal(timeline.compareActivityUsage(compareDay).timelineSeconds, 10)
  assert.equal(timeline.compareActivityUsage(compareDay).legacySeconds, 10)
  console.log('✓ 首日已有27分钟不作为新算法偏差：采样前不可比，建立共同起点后仅比较新增时长，重复/重启不重置')
  db.prepare('DELETE FROM settings WHERE key = ?').run(`activityTimelineComparison:${compareDay}`)
  assert.equal(timeline.compareActivityUsage(compareDay).comparable, false)
  timeline.persistActivityIntervals([{ ...afterRestart, endMs: compareStart + 20_000 }], compareStart + 20_000)
  usage.addAppUsage(compareDay, 'Code', 5)
  comparison = timeline.compareActivityUsage(compareDay)
  assert.equal(comparison.comparisonFromMs, compareStart + 15_000)
  assert.equal(comparison.timelineSeconds, 5)
  assert.equal(comparison.legacySeconds, 5)
  assert.equal(comparison.deltaSeconds, 0)
  db.prepare('DELETE FROM app_usage WHERE day = ?').run(compareDay)
  comparison = timeline.compareActivityUsage(compareDay)
  assert.equal(comparison.comparable, false)
  assert.equal(comparison.comparisonReason, 'legacy_baseline_reset')
  assert.equal(comparison.legacySeconds, 0)
  timeline.persistActivityIntervals([{ ...afterRestart, endMs: compareStart + 25_000 }], compareStart + 25_000)
  usage.addAppUsage(compareDay, 'Code', 5)
  comparison = timeline.compareActivityUsage(compareDay)
  assert.equal(comparison.comparable, true)
  assert.equal(comparison.comparisonFromMs, compareStart + 20_000)
  assert.equal(comparison.legacySeconds, 5)
  assert.equal(comparison.timelineSeconds, 5)
  console.log('✓ 元数据缺失不反推整日旧基准；从上一heartbeat重建共同起点；aggregate清空后下一batch自动rebase')

  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('activityTimelineComparison:2025-01-01', '{}')
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('activityTimelineComparisonOther:2025-01-01', 'keep')
  timeline.persistActivityIntervals([{ ...i, id: 'comparison-prune-heartbeat', startMs: start + 3_600_001,
    endMs: start + 3_600_001 }], start + 3_600_001)
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('activityTimelineComparison:2025-01-01'), undefined)
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('activityTimelineComparisonOther:2025-01-01').value, 'keep')
  assert.ok(db.prepare('SELECT value FROM settings WHERE key = ?').get(`activityTimelineComparison:${compareDay}`))
  console.log('✓ 90天prune只清理过期对照prefix metadata，保留近期基准与其他settings')

} finally {
  db?.close()
  delete globalThis.demoDb
  delete globalThis.demoSettings
  rmSync(temp, { recursive: true, force: true })
}
