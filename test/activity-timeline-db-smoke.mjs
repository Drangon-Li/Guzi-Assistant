import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { posix, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import ts from 'typescript'

// 时间线是应用时长、切换和工作记录的唯一来源：用真实 SQLite 跑一遍各领域模块。
const Database = (await import('better-sqlite3')).default
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'guzi-activity-demo-'))
const modules = ['src/shared/parsing.ts', 'src/shared/work-report.ts', 'src/shared/activity-timeline.ts',
  'src/main/db-migrations.ts', 'src/main/db/activity-retention.ts', 'src/main/db/work-records.ts', 'src/main/db/activity-timeline.ts', 'src/main/db/app-usage.ts']
const stubs = {
  'src/main/db/connection.ts': 'export const getDb = () => globalThis.demoDb;'
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
  const retention = await load('src/main/db/activity-retention.ts')
  const { focusDurations } = await load('src/shared/work-report.ts')
  db = globalThis.demoDb = new Database(':memory:')
  db.exec(`CREATE TABLE work_records (id TEXT PRIMARY KEY, content TEXT, app TEXT, created_at TEXT);
    CREATE TABLE app_usage (day TEXT, app TEXT, seconds REAL, PRIMARY KEY(day, app));
    CREATE TABLE ocr_evidence (id TEXT PRIMARY KEY, occurred_at TEXT);`)
  migrate.migrateWorkRecords(db)
  migrate.migrateActivityTimeline(db)
  // 用昨天：时间线只在 90 天保留期内被读取，写死日期的话过一阵子测试就会自己失效
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`
  const start = new Date(`${day}T09:00:00`).getTime()
  const i = { id: 'interval-1', sessionId: 'demo', startMs: start, endMs: start + 60_000,
    state: 'active', appName: 'Code', bundleId: 'com.code', historyAllowed: true, endReason: 'heartbeat' }
  timeline.persistActivityIntervals([i], start)
  timeline.persistActivityIntervals([i], start)
  assert.equal(timeline.listActivityIntervals(start, start + 600_000).length, 1)
  usage.addAppUsage(day, 'Code', 99)
  assert.equal(usage.appUsageSummary(day)[0].seconds, 60)
  assert.equal(usage.appUsageRange(day, day)[0].seconds, 60)
  assert.equal(work.listWorkRecords(day)[0].activeMs, 60_000)
  assert.equal(work.listWorkRecords(day)[0].task, null)
  console.log('✓ SQLite真实domain：重复interval upsert幂等；保留期内只读时间线、不读汇总表；无摘要的活动以unknown保留')
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
  // 开发库里可能残留旧 OCR / History 派生行：既不显示，也不参与计时
  for (const [id, derivedBy] of [['stale-legacy', 'legacy'], ['stale-history', 'history']]) {
    db.prepare(`INSERT INTO work_records (id, content, app, task, evidence_source, start_at, end_at, derived_by, created_at)
      VALUES (?, '旧路径', 'Code', '开发项目', 'ocr', ?, ?, ?, ?)`).run(id, `${day}T09:00:00`, `${day}T09:01:00`, derivedBy, `${day}T09:00:00`)
  }
  records = work.listWorkRecords(day)
  assert.equal(records.length, 3)
  assert.ok(records.every((r) => r.derivedBy === 'timeline'))
  assert.equal(focusDurations(records)[0].seconds, 30)
  console.log('✓ 非时间线的旧记录行被忽略，不重复计时')
  timeline.persistActivityIntervals([{ ...i, id: 'excluded', startMs: start + 60_000, endMs: start + 120_000, historyAllowed: false }], start)
  assert.equal(usage.appUsageSummary(day)[0].seconds, 120)
  console.log('✓ History排除不影响Appusage授权')
  timeline.persistActivityIntervals([{ ...i, id: 'switch-b', startMs: start + 120_000, endMs: start + 150_000, appName: 'Safari', bundleId: 'com.safari' }], start)
  const switches = usage.listAppSwitchesSince(day)
  assert.deepEqual(switches.map((s) => [s.fromApp, s.toApp]), [[null, 'Code'], ['Code', 'Code'], ['Code', 'Safari']])
  assert.equal(switches.at(-1).activeMs, 30_000)
  console.log('✓ 应用切换由相邻的活跃区间推出，带真实停留时长')
  db.prepare("DELETE FROM activity_intervals WHERE id = 'switch-b'").run() // 后面的时长断言只针对 Code 的两段
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

} finally {
  db?.close()
  delete globalThis.demoDb
  rmSync(temp, { recursive: true, force: true })
}
