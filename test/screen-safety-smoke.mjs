import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import ts from 'typescript'
import {
  captureVerifiedWindow, parseScreenSnapshot, screenWindowKey, ScreenCaptureBlocked
} from '../src/main/screen-snapshot.ts'
import { ScreenRetryState, ScanGeneration } from '../src/main/screen-retry.ts'
import { ensureNativeHelperBinary } from '../src/main/native-helper-cache.ts'

const snapshot = (patch = {}) => ({ observedAtMs: Date.now(), pid: 42, windowId: 900,
  name: 'Editor', bundleId: 'test.editor', windowTitle: 'demo', accessibility: 'available',
  focusedRole: 'AXTextArea', focusedSubrole: null, secureInput: false, ...patch })

let captures = 0, uploads = 0
for (const patch of [{ secureInput: true }, { secureInput: null }, { accessibility: 'unavailable' }, { focusedRole: null }, { windowId: null }]) {
  const current = snapshot(patch)
  await assert.rejects(async () => {
    const path = await captureVerifiedWindow({ initial: current, readSnapshot: async () => current,
      privacyReason: () => null, capture: async () => { captures++; return '/fake.png' }, remove: async () => {} })
    if (path) uploads++
  }, ScreenCaptureBlocked)
}
assert.equal(captures, 0)
assert.equal(uploads, 0)
console.log('✓ 密码/未知AX/缺窗口身份：零截图、零上传')
assert.equal(parseScreenSnapshot({ ...snapshot(), secureInput: undefined }).secureInput, null)
assert.notEqual(screenWindowKey(snapshot()), screenWindowKey(snapshot({ windowId: 901 })))

const removed = []
const initial = snapshot()
let reads = 0
await assert.rejects(captureVerifiedWindow({ initial,
  readSnapshot: async () => ++reads === 1 ? initial : snapshot({ windowId: 901 }),
  privacyReason: () => null, capture: async (id) => { assert.equal(id, 900); return '/switch.png' },
  remove: async (path) => removed.push(path) }), ScreenCaptureBlocked)
assert.deepEqual(removed, ['/switch.png'])
for (const cursorDisplay of [1, 2]) {
  const result = await captureVerifiedWindow({ initial, readSnapshot: async () => snapshot(), privacyReason: () => null,
    capture: async (id) => { assert.equal(id, 900); return `/display-${cursorDisplay}.png` }, remove: async () => {} })
  assert.ok(result)
}
console.log('✓ 切窗丢弃并清理截图；双屏鼠标位置不改变目标window ID')

const retry = new ScreenRetryState()
for (const [index, wait] of [45_000, 90_000, 180_000, 300_000, 300_000].entries()) {
  const now = index * 1_000_000
  retry.fail('one', new Error('OCR failed'), now)
  assert.equal(retry.ready('one', now + wait - 1), false)
  assert.equal(retry.retryDue('one', now + wait), true)
  assert.equal(retry.state('one').successfulHash, null)
}
retry.fail('rate', Object.assign(new Error('额度不足（429）'), { status: 429, retryAfterMs: 600_000 }), 0)
assert.equal(retry.ready('rate', 599_999), false)
assert.equal(retry.retryDue('rate', 600_000), true)
retry.fail('auth', Object.assign(new Error('bad key'), { status: 401 }), 0)
assert.equal(retry.ready('auth', 1e12), false)
retry.reset()
assert.equal(retry.ready('auth', 0), true)
retry.succeed('one', 5n, 'zero-results')
assert.equal(retry.state('one').successfulHash, 5n)
assert.equal(retry.state('two').successfulHash, null)
console.log('✓ OCR/模型错误退避45/90/180/300秒；429遵守Retry-After；认证等待配置变化')

const ttl = new ScreenRetryState()
ttl.succeed('window', 5n, 'first', 1_000)
assert.equal(ttl.shouldSkipHash('window', 5n, 600_999), true)
assert.equal(ttl.shouldSkipText('window', 'first', 600_999), true)
assert.equal(ttl.shouldSkipHash('window', 5n, 601_000), false)
assert.equal(ttl.shouldSkipText('window', 'first', 601_000), false)
ttl.succeed('window', 5n, 'first', 2_000_000)
ttl.succeed('window', 6n, 'second', 2_001_000)
assert.equal(ttl.shouldSkipText('window', 'first', 2_002_000), true)
assert.equal(ttl.shouldSkipText('other', 'first', 2_002_000), false)
ttl.fail('window', Error('network failed'), 2_002_000)
assert.equal(ttl.shouldSkipHash('window', 6n, 2_047_000), false)
assert.equal(ttl.shouldSkipText('window', 'second', 2_047_000), false)
assert.equal(ttl.retryDue('window', 2_047_000), true)
ttl.markEmptyOcr('empty', 9n, 3_000_000)
assert.equal(ttl.state('empty').successfulHash, null)
assert.equal(ttl.state('empty').successfulTextHash, null)
assert.equal(ttl.state('empty').failures, 0)
assert.equal(ttl.ready('empty', 3_044_999), false)
assert.equal(ttl.retryDue('empty', 3_045_000), true)
ttl.markEmptyOcr('empty', 9n, 3_045_000)
assert.equal(ttl.state('empty').failures, 0)
assert.equal(ttl.state('empty').emptyOcrRetryAtMs, 3_090_000)
ttl.succeed('empty', 9n, 'nonempty recovered', 3_090_000)
assert.equal(ttl.retryDue('empty', 3_090_000), false)
assert.equal(ttl.shouldSkipHash('empty', 9n, 3_090_000), true)
console.log('✓ 成功hash/文本10分钟过期刷新；窗口内A→B→A冷却；失败优先重试；空OCR仅45秒冷却且不标模型成功')


const generation = new ScanGeneration()
const old = generation.begin()
generation.cancel()
assert.equal(old.current(), false)
assert.equal(old.signal.aborted, true)
assert.equal(generation.begin().current(), true)

const directory = await mkdtemp(join(tmpdir(), 'guzi-screen-demo-'))
try {
  let builds = 0
  const options = { directory, binaryName: 'frontmost-context-v3-oneshot', source: 'first',
    compile: async (_, output) => { builds++; await writeFile(output, `binary-${builds}`) } }
  await writeFile(join(directory, options.binaryName), 'stale-pre-hash')
  await ensureNativeHelperBinary(options)
  await ensureNativeHelperBinary(options)
  await ensureNativeHelperBinary({ ...options, source: 'changed' })
  assert.equal(builds, 2)
  assert.equal(await readFile(join(directory, options.binaryName), 'utf8'), 'binary-2')
} finally { await rm(directory, { recursive: true, force: true }) }
console.log('✓ helper旧缓存替换、同源码复用、源码变化自动重编')

// Run the real watcher with all OS/cloud/storage boundaries replaced by deterministic fixtures.
const fixture = {
  current: snapshot(), now: Date.now(), capture: 0, model: 0, ocr: 0, writes: 0,
  ocrError: false, modelError: false, onModel: null, modelItems: [], tick: null,
  semanticGate: true, collectorBlocked: false, restoreTarget: null, restores: 0, restoreShowsOwn: false, excludedApp: null, capturedWindowIds: [],
  settings: { screenSenseKeepShots: false, screenSensePopup: false, screenSenseWorkLog: false,
    screenSenseVlmConfirm: false, screenSenseEventDriven: true, screenSenseFallbackIntervalSec: 300,
    screenSenseHybridV2: true, todoScanEnabled: true, todoScanIntervalSec: 300, historyV2Enabled: false }
}
globalThis.__screenFixture = fixture
const mocks = {
  electron: `const image={resize(){return this},getSize(){return {width:9,height:8}},toBitmap(){return Buffer.alloc(9*8*4)},toJPEG(){return Buffer.alloc(1)}}; export const nativeImage={createFromPath(){return image}}, powerMonitor={getSystemIdleTime:()=>0}, systemPreferences={getMediaAccessStatus:()=> 'granted'};`,
  './capture': `export const HINTS={screen_scan:'',screen_scan_confirm:''}, emptyParseSummary=()=>({}); export async function captureScreenSilently(snapshot){f.capturedWindowIds.push(snapshot.windowId);f.capture++; return '/fake.png'}`,
  './ocr': `export async function ocrImageDetailed(){f.ocr++; if(f.ocrError)throw Error('OCR failed'); return [{text:'demo OCR',x:0,y:0,w:1,h:1}]}`,
  './parser': `export const cloudReady=()=>true; export async function parseToItemsRaw(){f.model++; if(f.onModel)await f.onModel(); if(f.modelError)throw Error('network failed'); return {items:f.modelItems,raw:{}}}`,
  './db': `export const getSettings=()=>f.settings, listFocusTaskCandidates=()=>[], getSource=()=>null, compareActivityUsage=()=>({legacySeconds:0,timelineSeconds:0,deltaSeconds:0,stateSeconds:{},endReasons:{},historyExcludedSeconds:0}), addOcrEvidence=()=>{f.writes++};`,
  './report-scheduler': 'export const applyReportSchedule=()=>{};',
  './windows': `export const debugEvent=()=>{},debugIsOpen=()=>false,hideMainForCapture=()=>{if(!f.restoreTarget)return null;f.current=f.restoreTarget;let done=false;return()=>{if(!done){f.restores++;if(f.restoreShowsOwn)f.current={...f.current,name:'Own'}}done=true}},showPreview=()=>{},isPreviewVisible=()=>false;`,
  './pet/controller': `export const applyExternalPetSay=()=>{},isPetVisible=()=>false,setPetScanning=()=>{};`,
  './hotkey': `export const initScanHotkey=()=>{},unregisterScanHotkey=()=>{};`,
  './frontapp': `export const getScreenSnapshot=async()=>({...f.current,observedAtMs:Date.now()});`,
  './shotvault': `export const saveShotTempFromPng=()=>{f.writes++},deleteShot=()=>{},listShotIds=()=>[],sweepTempShots=()=>{};`,
  './activity-tracker': `export const activityScanDecision=()=>({run:f.semanticGate,reason:f.semanticGate?'event':'waiting'}),getScreenActivityStatus=()=>({}),markActivityScan=()=>{},configureActivityHistoryPersistence=()=>{},configureSemanticWorkClassifier=()=>{},getHybridSemanticState=()=>({assessment:{score:100},contextKey:'demo'}),markOcrFallback=()=>{},recordOcrEvidence=()=>{f.writes++},recordScreenChange=()=>{},resetActivityGate=()=>{},startActivityCollector=()=>{},stopActivityCollector=()=>{},getCollectorCaptureSafety=()=>({blocked:f.collectorBlocked,reason:f.collectorBlocked?'collector secure':null});`,
  './detection-cards': `export const buildDetectionCards=()=>[],parsedToExtraction=x=>x,showDetectedCards=()=>{},sweepCompletedDetections=()=>{};`,
  './work-records': `export const legacyWorkSummaryHint=()=>'',maybeAddWorkRecord=()=>{},resetWorkRecordThrottle=()=>{},scheduleSemanticWork=()=>{},shouldPersistLegacyOcrWork=()=>false,stopSemanticWorkClassifier=()=>{},workSummaryHint=()=>'';`,
  './privacy': `export const privacyForContext=context=>({suppressed:context.name==='Own'||context.name===f.excludedApp,privacyState:context.name==='Own'?'own':context.name===f.excludedApp?'excluded':'normal'});`,
  './usage-sampler': `export const IDLE_SKIP_SEC=60,startUsageSampler=()=>{},stopUsageSampler=()=>{};`,
  './history/service.ts': `export const appendHistoryEventIfRunning=()=>{},appendOcrEvidenceIfAllowed=()=>{},historyContentAllowed=()=>true,getHistoryContentEpoch=()=>1,startHistoryPersistence=()=>{},stopHistoryPersistence=()=>{};`,
  '@shared/todo-scan': `export const shouldTodoScan=()=>false,todoScanAppKind=()=> 'content';`,
  '@shared/sensitive': `export const redactSensitive=text=>({text,hits:[]});`,
  '@shared/chat-layout': `export const looksLikeChat=()=>false,clusterChatSpeakers=()=>[],formatChatTranscript=()=>'';`,
  '@shared/shot-retention': `export const expiredShotIds=()=>[];`,
  '@shared/phash': `export const dhash=()=>1n,hamming=(a,b)=>a===b?0:64,bgraToGray=()=>[],textHash=text=>text;`,
  '@shared/detection-gate': `export const detectionQueueDecision=()=> 'queue';`,
  '@shared/work-report': `export const dayKey=()=> '2026-10-18';`,
  '@shared/parsing': `export const parseFocusTask=()=>null,parseWorkSummary=()=>null;`,
  '@shared/hybrid-history': `export const decideOcrTrigger=()=>({run:f.semanticGate,reason:'todo_scan'});`,
  'fs/promises': `export const unlink=async()=>{};`
}
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/src/main/screenwatch.ts') && mocks[specifier]) {
      return { url: `demo:${encodeURIComponent(specifier)}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('demo:')) return { format: 'module', shortCircuit: true,
      source: 'const f=globalThis.__screenFixture;'+mocks[decodeURIComponent(url.slice(5))] }
    if (url.endsWith('/src/main/screenwatch.ts')) {
      const loaded = next(url, context)
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(String(loaded.source).replace('async function watchTick()', 'export async function watchTick()'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
      }).outputText }
    }
    return next(url, context)
  }
})
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realNow = Date.now
Date.now = () => fixture.now
globalThis.setInterval = (callback) => { fixture.tick = callback; return 123 }
globalThis.clearInterval = () => {}
try {
  const watcher = await import('../src/main/screenwatch.ts')
  const tick = async () => { await watcher.watchTick() }
  watcher.startWatch(5)
  for (const patch of [{ secureInput: true }, { secureInput: null }, { accessibility: 'unavailable' }]) {
    fixture.current = snapshot(patch)
    await tick()
  }
  assert.equal(fixture.capture, 0)
  assert.equal(fixture.model, 0)
  assert.ok(watcher.screenActivityStatus().screenshotPauseReason)
  fixture.current = snapshot()
  fixture.collectorBlocked = true
  await tick()
  assert.equal(fixture.capture, 0)
  fixture.collectorBlocked = false
  fixture.ocrError = true
  await tick()
  assert.equal(fixture.capture, 1)
  fixture.ocrError = false
  fixture.semanticGate = false // A normal OCR/todo gate must not swallow the pending failure retry.
  fixture.now += 44_999
  await tick()
  assert.equal(fixture.capture, 1)
  fixture.now += 1
  fixture.modelError = true
  await tick()
  assert.equal(fixture.model, 1)
  fixture.modelError = false
  fixture.now += 89_999
  await tick()
  assert.equal(fixture.model, 1)
  fixture.now += 1
  await tick()
  assert.equal(fixture.model, 2)
  assert.equal(fixture.writes, 1)
  fixture.semanticGate = true
  await tick()
  assert.equal(fixture.model, 2, 'zero-result model success must deduplicate the same image')
  fixture.current = snapshot({ windowId: 901 })
  await tick()
  assert.equal(fixture.model, 3, 'the same image in another window has its own success state')
  console.log('✓ 真实watcher：OCR失败→45秒同画面重试→模型失败→90秒恢复；正常gate不吞重试；零结果去重且窗口隔离')
  fixture.current = snapshot({ windowId: 902 })
  let releaseModel
  let startedModel
  const entered = new Promise(resolve => { startedModel = resolve })
  fixture.onModel = () => { startedModel(); return new Promise(resolve => { releaseModel = resolve }) }
  const running = tick()
  await entered
  const writesBefore = fixture.writes
  watcher.setWatchPaused(true)
  releaseModel()
  await running
  assert.equal(fixture.writes, writesBefore, 'paused generation cannot persist a late model response')
  assert.equal(fixture.model, 4)
  console.log('✓ 真实watcher：pause后旧模型响应零新增落库')
  fixture.onModel = null
  const priorCapture = fixture.capture
  fixture.current = snapshot({ secureInput: null })
  assert.equal((await watcher.scanOnce()).status, 'empty')
  assert.equal(fixture.capture, priorCapture)
  fixture.current = snapshot({ name: 'Own' })
  assert.equal((await watcher.scanOnce()).status, 'empty')
  assert.equal(fixture.capture, priorCapture, 'manual cannot guess a target if own window remains active')
  fixture.restoreTarget = snapshot({ windowId: 950 })
  assert.equal((await watcher.scanOnce()).status, 'empty')
  assert.equal(fixture.capturedWindowIds.at(-1), 950)
  assert.equal(fixture.restores, 1)
  console.log('✓ 真实手动scanOnce：未知安全态零截图；仍为自身时不猜目标；让开主窗后使用重新验证的窗口并恢复主窗')
  fixture.current = snapshot({ windowId: 960 })
  fixture.restoreTarget = null
  fixture.modelItems = [{ title: 'candidate' }]
  fixture.settings.screenSenseVlmConfirm = true
  fixture.onModel = async () => { fixture.current = snapshot({ windowId: 961 }) }
  const modelBeforeVisual = fixture.model
  const writesBeforeVisual = fixture.writes
  watcher.setWatchPaused(false)
  await tick()
  assert.equal(fixture.model, modelBeforeVisual + 1, 'window change during text model must prevent the second visual upload')
  assert.equal(fixture.writes, writesBeforeVisual)
  console.log('✓ 真实watcher：文字模型等待期间切窗，第二次VLM上传为零且不落库')
  fixture.onModel = null
  fixture.restoreShowsOwn = true
  fixture.current = snapshot({ name: 'Own' })
  fixture.restoreTarget = snapshot({ windowId: 970 })
  const manualModelBefore = fixture.model
  assert.equal((await watcher.scanOnce()).status, 'suggested')
  assert.equal(fixture.current.name, 'Own')
  assert.equal(fixture.model, manualModelBefore + 2, 'restoring Guzi must not block an explicitly captured manual window visual upload')
  fixture.current = snapshot({ name: 'Own' })
  fixture.restoreTarget = snapshot({ windowId: 971 })
  fixture.onModel = async () => { fixture.excludedApp = 'Editor' }
  const beforeManualPolicy = fixture.model
  const beforeManualPolicyWrites = fixture.writes
  assert.equal((await watcher.scanOnce()).status, 'error')
  assert.equal(fixture.model, beforeManualPolicy + 1)
  assert.equal(fixture.writes, beforeManualPolicyWrites)
  console.log('✓ 真实手动VLM：恢复Guzi不误拦原窗口；文字等待期间将原窗口加入排除名单则零二次上传')
  watcher.stopWatch()
} finally {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  Date.now = realNow
  hook.deregister()
  delete globalThis.__screenFixture
}

// Exercise the production screencapture adapter with a fake child process, including cleanup.
const captureDirectory = await mkdtemp(join(tmpdir(), 'guzi-capture-adapter-'))
const adapter = { current: snapshot(), directory: captureDirectory, calls: [], switchDuringCapture: false, fail: false, blocked: false }
globalThis.__captureAdapter = adapter
const captureMocks = {
  electron: `export const app={getPath:()=>a.directory},clipboard={},nativeImage={};`,
  child_process: `import{writeFileSync}from'node:fs'; export function execFileSync(){throw Error('unexpected synchronous capture')} export function execFile(command,args,options,callback){a.calls.push({command,args,options});writeFileSync(args.at(-1),'fake-pixels');if(a.switchDuringCapture)a.current={...a.current,windowId:901};callback(a.fail?Error('timed out'):null)}`,
  'pdf-parse': 'export default ()=>{};', mammoth: 'export default {};',
  '@shared/sensitive': 'export const detectSensitive=()=>[],redactSensitive=text=>({text,hits:[]});',
  './db': 'export const createSource=()=>{},deleteSourceRow=()=>{},findDuplicateTitle=()=>{},getProfile=()=>{};',
  './task-ingest': 'export const createTaskFromItem=()=>{},scheduledStatus=()=>{};',
  './parser': 'export const parseToItems=()=>{};',
  './windows': 'export const broadcast=()=>{},showPreview=()=>{};',
  './pet/controller': 'export const applyExternalPetReaction=()=>{};',
  './frontapp': 'export const getScreenSnapshot=async()=>({...a.current,observedAtMs:Date.now()});',
  './privacy': `export const privacyForContext=()=>({suppressed:false});`,
  './activity-tracker': `export const getCollectorCaptureSafety=()=>({blocked:a.blocked,reason:a.blocked?'collector secure':null});`
}
const captureHook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/src/main/capture.ts') && captureMocks[specifier]) return {
      url: `capture-demo:${encodeURIComponent(specifier)}`, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('capture-demo:')) return { format: 'module', shortCircuit: true,
      source: 'const a=globalThis.__captureAdapter;'+captureMocks[decodeURIComponent(url.slice(13))] }
    if (url.endsWith('/src/main/capture.ts')) {
      const loaded = next(url, context)
      // This fixture exercises the macOS command; Windows has its own native adapter fixture.
      const source = String(loaded.source).replace(/\bprocess\.platform\b/g, "'darwin'")
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
      }).outputText }
    }
    return next(url, context)
  }
})
try {
  const { captureScreenSilently } = await import('../src/main/capture.ts')
  const { readdir, unlink } = await import('node:fs/promises')
  const file = await captureScreenSilently(adapter.current)
  assert.equal(adapter.calls[0].command, '/usr/sbin/screencapture')
  assert.deepEqual(adapter.calls[0].args.slice(0, -1), ['-l900', '-o', '-x'])
  assert.equal(adapter.calls[0].options.timeout, 10_000)
  await unlink(file)
  adapter.switchDuringCapture = true
  await assert.rejects(captureScreenSilently(snapshot()), ScreenCaptureBlocked)
  assert.deepEqual(await readdir(captureDirectory), [])
  adapter.switchDuringCapture = false
  adapter.current = snapshot()
  adapter.fail = true
  await assert.rejects(captureScreenSilently(adapter.current), /timed out/)
  assert.deepEqual(await readdir(captureDirectory), [])
  const count = adapter.calls.length
  adapter.blocked = true
  await assert.rejects(captureScreenSilently(adapter.current), ScreenCaptureBlocked)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(captureScreenSilently(adapter.current, abort.signal), { name: 'AbortError' })
  assert.equal(adapter.calls.length, count)
  console.log('✓ 真实截图适配器：精确-l900 -o -x、10秒timeout、切窗/失败清临时图、取消与collector安全态零启动')
} finally {
  captureHook.deregister()
  delete globalThis.__captureAdapter
  await rm(captureDirectory, { recursive: true, force: true })
}

console.log('\n屏幕安全demo全部通过（无真实截图、无云调用、无用户DB）')
