import {
  activityScanDecision,
  configureActivityHistoryPersistence,
  getScreenActivityStatus,
  isPrivateBrowsingContext,
  markActivityObserverFailure,
  markActivityScan,
  recordOcrEvidence,
  recordFrontmostContext,
  configureSemanticWorkClassifier,
  startActivityCollector,
  stopActivityCollector,
  invalidateActivityHistoryPersistenceCache,
  resetActivityGate
} from '../src/main/activity-tracker.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const START = 1_000_000
const context = { name: 'Code', bundleId: 'com.microsoft.VSCode', windowTitle: 'project.ts' }

resetActivityGate(START)
check('观察器就绪前自动扫描 fail-closed', activityScanDecision(true, 45, START).reason === 'waiting')
recordFrontmostContext(context, { suppressed: false, nowMs: START + 1000 })
check('首次上下文触发事件扫描', activityScanDecision(true, 45, START + 1000).reason === 'event')
markActivityScan('event', START + 1000)
check('扫描后门控关闭', !activityScanDecision(true, 45, START + 20_000).run)
check('静止到兜底间隔后扫描', activityScanDecision(true, 45, START + 46_000).reason === 'hard_fallback')

recordFrontmostContext(
  { name: 'Password Manager', bundleId: 'com.password', windowTitle: 'Secret' },
  { suppressed: true, nowMs: Date.now() }
)
const status = getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
check('被抑制上下文不进入摘要', !status.latestSummary?.includes('Secret'))
check(
  '浏览器私密窗口会被识别',
  isPrivateBrowsingContext({
    name: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    windowTitle: 'New Incognito Window'
  })
)
check(
  '普通应用标题不误判私密浏览',
  !isPrivateBrowsingContext({ name: 'Code', bundleId: 'com.microsoft.VSCode', windowTitle: 'private.ts' })
)

let semanticCalls = 0
configureSemanticWorkClassifier(() => { semanticCalls += 1 })
recordFrontmostContext(
  { name: 'Keychain', bundleId: 'com.example.keychain', windowTitle: 'Credentials', focusedRole: 'AXSecureTextField' },
  { suppressed: true, privacyState: 'secure', nowMs: Date.now() + 2 }
)
configureSemanticWorkClassifier(null)
check('secure 事件不进入工作归类', semanticCalls === 0)

const oauthTitle = 'Sign in - http://localhost:4312/callback?state=secret-state&code=secret-code'
const oauthEvent = recordFrontmostContext(
  { name: 'Safari', bundleId: 'com.apple.Safari', windowTitle: oauthTitle },
  { suppressed: false, nowMs: Date.now() + 1 }
)
check(
  '事件证据在入队前移除 OAuth URL 和参数',
  oauthEvent?.windowTitle === 'Sign in - [已隐去·网址]' &&
    !/localhost|state=|code=|secret-state|secret-code/.test(oauthEvent.windowTitle)
)

let persistedOcrEvidence = null
configureActivityHistoryPersistence({
  upsertSegment: () => {},
  addOcrEvidence: (record) => { persistedOcrEvidence = record }
})
const savedOcrEvidence = recordOcrEvidence({
  eventId: oauthEvent?.id ?? null,
  occurredAtMs: Date.now(),
  appName: 'Safari',
  bundleId: 'com.apple.Safari',
  windowTitle: oauthTitle,
  semanticScore: 40,
  triggerReason: 'partial_retry',
  redactionHits: [],
  redactedText: 'Sign in'
})
const blockedOcrEvidence = recordOcrEvidence({
  eventId: null,
  occurredAtMs: Date.now(),
  appName: 'Keychain',
  bundleId: 'com.example.keychain',
  windowTitle: 'Credentials',
  semanticScore: 0,
  triggerReason: 'manual',
  redactionHits: [],
  redactedText: 'secret',
  privacyState: 'secure'
})
configureActivityHistoryPersistence(null)
check(
  'OCR 证据持久化前再次净化窗口标题',
  savedOcrEvidence.windowTitle === 'Sign in - [已隐去·网址]' &&
    persistedOcrEvidence?.windowTitle === savedOcrEvidence.windowTitle
)
check('secure OCR 证据不落库', blockedOcrEvidence === null)

let segmentWrites = 0
configureActivityHistoryPersistence({
  upsertSegment: () => { segmentWrites += 1 },
  addOcrEvidence: () => {}
})
const stableAt = Date.now() + 100
resetActivityGate(stableAt)
recordFrontmostContext(
  { name: 'Code', bundleId: 'com.microsoft.VSCode', windowTitle: 'stable.ts' },
  { suppressed: false, privacyState: 'normal', nowMs: stableAt }
)
getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
const firstSegmentWriteCount = segmentWrites
getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
check('unchanged activity segments skip repeated persistence callbacks', firstSegmentWriteCount > 0 && segmentWrites === firstSegmentWriteCount)
recordFrontmostContext(
  { name: 'Code', bundleId: 'com.microsoft.VSCode', windowTitle: 'changed.ts' },
  { suppressed: false, privacyState: 'normal', nowMs: stableAt + 1_000 }
)
getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
check('changed activity segments are persisted again', segmentWrites > firstSegmentWriteCount)
const writesBeforeExternalWipe = segmentWrites
invalidateActivityHistoryPersistenceCache()
getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
check('external database wipe invalidates baseline fingerprints', segmentWrites > writesBeforeExternalWipe)
configureActivityHistoryPersistence(null)

const persistedEvents = []
configureActivityHistoryPersistence({
  upsertSegment: () => {},
  addOcrEvidence: () => {},
  appendHistoryEvent: (event) => persistedEvents.push(event)
})
resetActivityGate(Date.now() + 10)
const dualWriteAt = Date.now() + 5_000
recordFrontmostContext(
  { name: 'Code', bundleId: 'com.microsoft.VSCode', windowTitle: 'history.ts' },
  { suppressed: false, privacyState: 'normal', nowMs: dualWriteAt }
)
recordFrontmostContext(
  { name: 'Keychain', bundleId: 'com.example.keychain', windowTitle: 'Credentials' },
  { suppressed: true, privacyState: 'secure', nowMs: dualWriteAt + 1_000 }
)
configureActivityHistoryPersistence(null)
check('collector events are forwarded to the optional history writer', persistedEvents.length === 2)
check(
  'forwarded events carry explicit privacy state',
  persistedEvents[0]?.privacyState === 'normal' && persistedEvents[1]?.privacyState === 'secure'
)

markActivityObserverFailure('helper failed')
check('观察器失败后停止自动截图', activityScanDecision(true, 45).reason === 'observer_unavailable')
check('关闭事件驱动时保留固定间隔模式', activityScanDecision(false, 45).reason === 'interval')

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
const allowCollectorContext = () => ({ suppressed: false, privacyState: 'normal' })
const starts = []
const stoppedHandles = []
const makeCollectorModule = (label, onStart = null) => ({
  startFrontmostCollector: (onEvent, onHealth) => {
    const handle = {
      stop: () => stoppedHandles.push(label)
    }
    starts.push({ label, onEvent, onHealth })
    onStart?.()
    return handle
  }
})

const delayedA = deferred()
const delayedB = deferred()
startActivityCollector(allowCollectorContext, () => delayedA.promise)
stopActivityCollector()
startActivityCollector(allowCollectorContext, () => delayedB.promise)
delayedA.resolve(makeCollectorModule('A'))
await flushMicrotasks()
check('旧动态导入返回后不会启动旧 collector', starts.length === 0)
delayedB.resolve(makeCollectorModule('B'))
await flushMicrotasks()
check('新动态导入只启动当前 collector', starts.length === 1 && starts[0].label === 'B')
stopActivityCollector()
check('停止当前 collector 会释放其 handle', stoppedHandles.filter((label) => label === 'B').length === 1)
starts[0]?.onHealth({
  state: 'healthy',
  restartCount: 0,
  lastHeartbeatAtMs: Date.now(),
  accessibility: 'available',
  detail: 'late callback',
  inputMonitoring: 'available'
})
check(
  '旧 collector 的迟到 health 回调不会恢复全局状态',
  getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false }).collector === 'stopped'
)
starts[0]?.onEvent({
  type: 'heartbeat',
  appName: '',
  bundleId: '',
  windowTitle: '',
  occurredAtMs: Date.now(),
  accessibility: 'available',
  inputMonitoring: 'available'
})
check(
  '旧 collector 的迟到 event 回调不会更新全局心跳',
  getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false }).lastHeartbeatAt === null
)

let postStartHandleStops = 0
const delayedC = deferred()
startActivityCollector(allowCollectorContext, () => delayedC.promise)
delayedC.resolve(makeCollectorModule('C', () => stopActivityCollector()))
await flushMicrotasks()
postStartHandleStops = stoppedHandles.filter((label) => label === 'C').length
check('启动返回期间代次失效会立即停止孤儿 handle', postStartHandleStops === 1)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
