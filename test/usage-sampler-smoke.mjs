import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { posix, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'guzi-usage-demo-'))
const modules = ['src/main/usage-sampler.ts', 'src/shared/activity-timeline.ts', 'src/shared/work-report.ts']
const stubs = {
  'test/electron.ts': 'export const powerMonitor = globalThis.demo.power;',
  'src/main/db.ts': 'export const addAppUsage = (day, app, seconds) => globalThis.demo.usage.push({day,app,seconds});',
  'src/main/db/activity-timeline.ts': 'export const persistActivityIntervals = (rows) => rows.forEach((r) => globalThis.demo.rows.set(r.id,r));',
  'src/main/frontapp.ts': 'export const getFrontmostContext = async () => globalThis.demo.pending ?? globalThis.demo.context;',
  'src/main/activity-tracker.ts': 'export const markActivityObserverFailure = () => {}; export const markActivityObserverHealthy = () => {}; export const recordFrontmostContext = () => {}; export const getCollectorCaptureSafety = () => globalThis.demo.safety ?? ({blocked:false,urlHost:null});',
  'src/main/privacy.ts': `export const isOwnApp = (app) => app === 'Own';
    export const privacyForContext = (context, historyOnly) => { if(historyOnly) globalThis.demo.lastHistoryPrivacy = context; return {suppressed: false, privacyState:'normal'}; };`
}
const allPaths = new Set([...modules, ...Object.keys(stubs)])
function compile(name, source) {
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  code = code.replace(/(from\s*['"])([^'"]+)(['"])/g, (_, before, spec, after) => {
    if (spec !== 'electron' && !spec.startsWith('.') && !spec.startsWith('@shared/')) return before + spec + after
    let target = spec === 'electron' ? 'test/electron.ts' : spec.startsWith('@shared/') ? `src/shared/${spec.slice(8)}` : posix.resolve('/', posix.dirname(name), spec).slice(1)
    if (!target.endsWith('.ts')) target += '.ts'
    assert.ok(allPaths.has(target), `unexpected module ${target}`)
    return before + pathToFileURL(join(temp, target.replace(/\.ts$/, '.mjs'))).href + after
  })
  const path = join(temp, name.replace(/\.ts$/, '.mjs'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, code)
}
const realNow = Date.now
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now')
let timer
let sampler
try {
  for (const name of modules) compile(name, readFileSync(join(root, name), 'utf8'))
  for (const [name, source] of Object.entries(stubs)) compile(name, source)
  const base = new Date(2026, 9, 18, 9).getTime()
  globalThis.demo = { power: new EventEmitter(), usage: [], rows: new Map(),
    context: { name: 'A', bundleId: 'com.a', windowTitle: '' }, time: 0, idle: 0, paused: false }
  demo.power.getSystemIdleTime = () => demo.idle
  Date.now = () => base + demo.time
  Object.defineProperty(performance, 'now', { configurable: true, value: () => demo.time })
  globalThis.setInterval = (fn) => { timer = fn; return 123 }
  globalThis.clearInterval = () => { timer = undefined }
  sampler = await import(pathToFileURL(join(temp, 'src/main/usage-sampler.mjs')))
  const drain = () => new Promise((resolve) => setImmediate(resolve))
  const tick = async (time, app) => { demo.time = time; if (app) demo.context = { name: app, bundleId: `com.${app}`, windowTitle: '' }; timer(); await drain() }
  const total = () => demo.usage.reduce((sum, row) => sum + row.seconds, 0)
  // 应用切换由数据层从相邻活跃区间推出，这里直接看采样器写出的区间
  const activeRows = () => [...demo.rows.values()].filter((r) => r.state === 'active')
  sampler.startUsageSampler(() => demo.paused)
  await drain()
  await tick(5_000)
  await tick(10_000, 'B')
  await tick(15_000, 'A')
  await tick(20_000)
  assert.equal(total(), 20)
  assert.deepEqual(activeRows().map((r) => r.appName), ['A', 'B', 'A'])
  demo.time = 22_000
  demo.power.emit('lock-screen')
  await tick(25_000)
  await tick(30_000)
  assert.equal(total(), 20)
  demo.time = 3_600_000
  demo.power.emit('unlock-screen')
  await tick(3_600_000)
  await tick(3_605_000)
  assert.equal(total(), 25)
  assert.equal(activeRows().find((r) => r.endMs === base + 20_000)?.appName, 'A')
  console.log('✓ 真实sampler回放A→B→A、首App、lock/unlock：无睡眠补记，锁屏前的活跃区间有有限关闭边界')
  demo.paused = true
  await tick(3_610_000)
  demo.paused = false
  await tick(3_615_000)
  await tick(3_620_000)
  assert.equal(total(), 30)
  demo.idle = 60
  await tick(3_625_000)
  await tick(3_630_000)
  assert.equal(total(), 35)
  console.log('✓ 真实sampler暂停/idle阈值后的时段不累计；恢复从新heartbeat起算')
  demo.idle = 0
  let resolvePending
  demo.pending = new Promise((resolve) => { resolvePending = resolve })
  demo.time = 3_635_000
  timer()
  sampler.resetUsageTimelineBoundary()
  const count = demo.rows.size
  resolvePending({ name: 'StaleApp', bundleId: 'com.stale', windowTitle: '' })
  delete demo.pending
  await drain()
  assert.equal(demo.rows.size, count)
  assert.equal([...demo.rows.values()].some((r) => r.appName === 'StaleApp'), false)
  await tick(3_640_000)
  await tick(3_645_000)
  assert.equal(total(), 40)
  demo.safety = { blocked: true, urlHost: 'private.example' }
  await tick(3_650_000)
  await tick(3_655_000)
  assert.equal(total(), 50)
  assert.equal(demo.lastHistoryPrivacy.urlHost, 'private.example')
  assert.equal([...demo.rows.values()].filter((r) => r.state === 'active').at(-1).historyAllowed, false)
  demo.safety = { blocked: false, urlHost: 'allowed.example' }
  await tick(3_660_000)
  await tick(3_665_000)
  assert.equal(total(), 60)
  assert.equal(demo.lastHistoryPrivacy.urlHost, 'allowed.example')
  assert.equal([...demo.rows.values()].filter((r) => r.state === 'active').at(-1).historyAllowed, true)
  console.log('✓ 新鲜collector host传入History隐私判定；安全输入只禁History，Appusage持续授权')
  sampler.stopUsageSampler()
  assert.equal(timer, undefined)
  assert.equal(demo.power.listenerCount('lock-screen'), 0)
  console.log('✓ 删除边界换session并拒绝挂起旧context；stop移除timer/监听，无离线扩张')
} finally {
  sampler?.stopUsageSampler()
  Date.now = realNow
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor)
  else delete performance.now
  delete globalThis.demo
  rmSync(temp, { recursive: true, force: true })
}
