import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'guzi-semantic-privacy-'))
const modules = ['src/main/work-records.ts', 'src/shared/work-report.ts', 'src/shared/semantic-work.ts']
const stubs = {
  'src/main/db.ts': `export const addWorkRecord = (record) => { const row = { ...record, id: 'work-' + globalThis.demo.saved.length }; globalThis.demo.saved.push(row); return row; };
    export const getSettings = () => ({screenSenseWorkLog: true}); export const listFocusTaskCandidates = () => [];
    export const listKnownAppNames = () => ['Code']; export const localDateTimeAt = (ms) => new Date(ms).toISOString();`,
  'src/main/db/activity-timeline.ts': 'export const continuousActivityEvidence = () => null;',
  'src/main/db/work-records.ts': 'export const extendLegacyWorkRecord = () => {};',
  'src/main/parser.ts': `export const cloudReady = () => true;
    export const parseToItemsRaw = (input) => new Promise((resolve) => globalThis.demo.calls.push({ input, resolve }));`,
  'src/main/activity-tracker.ts': 'export const setWorkClassificationStatus = (status) => globalThis.demo.status.push(status);',
  'src/main/history/service.ts': `export const historyDerivedWorkActive = () => globalThis.demo.derived;
    export const getHistoryContentEpoch = () => globalThis.demo.epoch;
    export const historyContentAllowed = (context, epoch) => epoch === globalThis.demo.epoch && !globalThis.demo.paused && !globalThis.demo.blocked && context.urlHost !== 'blocked.example';`,
  'src/main/windows.ts': 'export const debugEvent = () => {};'
}
const paths = new Set([...modules, ...Object.keys(stubs)])
function compile(name, source) {
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  code = code.replace(/(from\s*['"])([^'"]+)(['"])/g, (_, before, spec, after) => {
    if (!spec.startsWith('.') && !spec.startsWith('@shared/')) return before + spec + after
    let target = spec.startsWith('@shared/') ? `src/shared/${spec.slice(8)}` : resolve('/', dirname(name), spec).slice(1)
    if (!target.endsWith('.ts')) target += '.ts'
    assert.ok(paths.has(target), `unexpected dependency ${target}`)
    return before + pathToFileURL(join(temp, target.replace(/\.ts$/, '.mjs'))).href + after
  })
  const path = join(temp, name.replace(/\.ts$/, '.mjs'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, code)
}
let work
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
try {
  for (const name of modules) compile(name, readFileSync(join(root, name), 'utf8'))
  for (const [name, source] of Object.entries(stubs)) compile(name, source)
  globalThis.demo = { calls: [], saved: [], status: [], derived: false, epoch: 0, paused: false, blocked: false }
  work = await import(pathToFileURL(join(temp, 'src/main/work-records.mjs')))
  const drain = () => new Promise((resolve) => setImmediate(resolve))
  const context = (id, patch = {}) => ({ appName: 'Code', bundleId: 'com.code', windowTitle: `ActivityTimeline-${id}.ts`,
    urlHost: 'allowed.example', focusedRole: 'text area', safeLabel: `ActivityTimeline-${id}`, eventKind: 'click', semanticScore: 8,
    source: 'accessibility', eventId: id, occurredAtMs: Date.now(), segmentId: `activity-10m-${id}`, highValueEvent: true, ...patch })
  const finish = async () => { demo.calls.at(-1).resolve({ raw: JSON.stringify({ work_summary: '编辑活动时间线代码', focus_task: '开发项目' }) }); await drain() }
  demo.derived = true
  work.scheduleSemanticWork(context('unified'))
  await drain()
  assert.equal(demo.calls.length, 0)
  demo.derived = false
  demo.paused = true
  work.scheduleSemanticWork(context('paused'))
  demo.paused = false
  work.scheduleSemanticWork(context('excluded', { urlHost: 'blocked.example' }))
  await drain()
  assert.equal(demo.calls.length, 0)
  console.log('✓ unified/History摘要路径不触发第二次旧AX模型调用；暂停与排除在调度前过滤')
  work.scheduleSemanticWork(context('normal'))
  await drain()
  assert.equal(demo.calls.length, 1)
  await finish()
  assert.equal(demo.saved.length, 1)
  work.scheduleSemanticWork(context('late-pause'))
  await drain()
  demo.paused = true
  demo.epoch++
  await finish()
  assert.equal(demo.saved.length, 1)
  demo.paused = false
  work.scheduleSemanticWork(context('late-delete'))
  await drain()
  demo.epoch++
  await finish()
  assert.equal(demo.saved.length, 1)
  work.scheduleSemanticWork(context('late-policy'))
  await drain()
  demo.blocked = true
  await finish()
  assert.equal(demo.saved.length, 1)
  demo.blocked = false
  console.log('✓ 模型等待期间暂停、删除epoch变化或当前排除规则变化，迟到结果均不写入')
  work.scheduleSemanticWork(context('running-before-stop'))
  work.scheduleSemanticWork(context('queued-before-stop'))
  await drain()
  assert.equal(demo.calls.length, 5)
  work.stopSemanticWorkClassifier()
  assert.equal(demo.calls.at(-1).input.signal.aborted, true)
  await finish()
  assert.equal(demo.calls.length, 5)
  assert.equal(demo.saved.length, 1)
  work.scheduleSemanticWork(context('after-restart'))
  await drain()
  await finish()
  assert.equal(demo.calls.length, 6)
  assert.equal(demo.saved.length, 2)
  console.log('✓ stop取消在途controller并废弃尚未开始的旧queue；重新调度可正常工作')
  let delayed
  globalThis.setTimeout = (callback) => { delayed = callback; return 123 }
  globalThis.clearTimeout = () => { delayed = undefined }
  work.scheduleSemanticWork(context('buffered-before-delete', { highValueEvent: false }))
  demo.epoch++
  delayed()
  await drain()
  assert.equal(demo.calls.length, 6)
  work.scheduleSemanticWork(context('switch-to-unified'))
  await drain()
  demo.derived = true
  await finish()
  assert.equal(demo.saved.length, 2)
  console.log('✓ 删除前缓冲的上下文不会以新epoch重入队；请求期间切换统一路径丢弃旧结果')
} finally {
  work?.stopSemanticWorkClassifier()
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  delete globalThis.demo
  rmSync(temp, { recursive: true, force: true })
}
