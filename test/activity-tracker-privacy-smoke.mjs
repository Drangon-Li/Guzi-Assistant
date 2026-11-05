import assert from 'node:assert/strict'
import {
  activityTracker,
  clearActivityHistoryEvidence,
  configureActivityHistoryPersistence,
  getCollectorCaptureSafety,
  recordCollectorEvent,
  recordOcrEvidence
} from '../src/main/activity-tracker.ts'
import { decideHistoryPrivacy } from '../src/main/history/privacy-policy.ts'

const START = Date.now()
const target = { bundleId: 'fixture.editor', windowId: 42 }
const writes = { events: [], ocr: [] }
configureActivityHistoryPersistence({
  appendHistoryEvent: (event) => writes.events.push(event),
  addOcrEvidence: (evidence) => writes.ocr.push(evidence)
})
const privacy = (context) => {
  const decision = decideHistoryPrivacy({ appName: context.name, bundleId: context.bundleId,
    windowTitle: context.windowTitle, focusedRole: context.focusedRole,
    focusedSubrole: context.focusedSubrole, secureInput: context.secureInput })
  return { suppressed: !decision.persist, privacyState: decision.state }
}
const emit = (at, patch = {}) => recordCollectorEvent({
  type: 'ax_focus_changed', appName: 'Fixture Editor', ...target,
  windowTitle: `fixture-${at}`, occurredAtMs: START + at,
  accessibility: 'available', ...patch
}, privacy)
const guard = (at, context = target) => getCollectorCaptureSafety(context, START + at)
const secured = (at) => emit(at, { secureInput: true, focusedRole: 'AXTextField',
  focusedSubrole: 'AXSecureTextField', safeLabel: 'secure-observation-marker', urlHost: 'private.fixture.test' })
const ocr = (at, text) => recordOcrEvidence({
  eventId: null, occurredAtMs: START + at, appName: 'Fixture Editor', ...target,
  windowTitle: 'fixture OCR', semanticScore: 10, triggerReason: 'partial_retry',
  redactionHits: [], redactedText: text, privacyState: 'normal'
})

try {
  clearActivityHistoryEvidence()
  secured(0)
  assert.equal(guard(0).blocked, true)
  emit(1_000, { type: 'heartbeat' })
  emit(2_000, { type: 'window_changed' })
  emit(3_000, { type: 'ax_attribute_changed', focusedRole: 'AXTextField' })
  emit(4_000, { type: 'ax_attribute_changed', secureInput: false })
  emit(5_000, { type: 'ax_attribute_changed', secureInput: false,
    focusedRole: 'AXTextArea', accessibility: 'unavailable' })
  assert.equal(guard(5_000).blocked, true, 'sparse or unavailable AX data must not clear a known secure target')
  assert.equal(guard(10_000).blocked, true)
  assert.equal(guard(10_001).blocked, false, 'sparse updates must not extend the original safety snapshot lifetime')
  emit(11_000, { secureInput: false, focusedRole: 'AXTextArea', urlHost: 'allowed.fixture.test' })
  assert.equal(guard(11_001).blocked, false, 'an explicit healthy focus can release a previous secure target')
  assert.equal(guard(21_000).urlHost, 'allowed.fixture.test')
  assert.equal(guard(21_001).urlHost, null)
  assert.equal(guard(11_001, { ...target, windowId: 43 }).urlHost, null)
  assert.equal(guard(11_001, { ...target, bundleId: 'fixture.other' }).urlHost, null)
  console.log('✓ 真实tracker：secure不会被稀疏heartbeat/缺字段/不可用AX覆盖，稀疏事件不续期；host仅在匹配应用窗口10秒内传递')

  clearActivityHistoryEvidence()
  emit(30_000, { secureInput: false, focusedRole: 'AXTextArea', safeLabel: 'keep-before-range' })
  ocr(30_000, 'keep OCR before range')
  emit(31_000, { secureInput: false, focusedRole: 'AXTextArea', safeLabel: 'erase-in-range' })
  ocr(31_000, 'erase OCR in range')
  const removedEventIds = activityTracker.events.filter((event) => event.occurredAtMs === START + 31_000).map((event) => event.id)
  emit(32_000, { secureInput: false, focusedRole: 'AXTextArea', safeLabel: 'keep-after-range' })
  ocr(32_000, 'keep OCR after range')
  clearActivityHistoryEvidence(START + 31_000, START + 32_000)
  assert.deepEqual(activityTracker.events.map((event) => event.occurredAtMs), [START + 30_000, START + 32_000])
  assert.deepEqual(activityTracker.ocrEvidence.map((evidence) => evidence.redactedText), ['keep OCR before range', 'keep OCR after range'])
  for (const id of removedEventIds) assert.equal(activityTracker.assessments.has(id), false)
  assert.equal(activityTracker.lastContext, null)
  assert.equal(activityTracker.latestContextKey, '')
  assert.equal(activityTracker.events.some((event) => event.safeLabel === 'erase-in-range'), false)

  secured(33_000)
  clearActivityHistoryEvidence(START + 33_000, START + 34_000)
  assert.equal(guard(33_001).blocked, true, 'range deletion must retain current secure protection')
  assert.equal(guard(33_001).urlHost, null, 'deleted observation host must be erased from the safety cache')
  assert.equal(activityTracker.lastCollectorContext.context.windowTitle, '')
  assert.equal(activityTracker.lastCollectorContext.context.safeLabel, '')
  clearActivityHistoryEvidence()
  assert.equal(activityTracker.events.length, 0)
  assert.equal(activityTracker.ocrEvidence.length, 0)
  assert.equal(activityTracker.assessments.size, 0)
  assert.equal(guard(33_002).blocked, true, 'clear-all must not clear secure protection')
  assert.equal(guard(33_002).urlHost, null)
  assert.ok(writes.events.length > 0 && writes.ocr.length > 0, 'production persistence boundaries were exercised with memory-only sinks')
  console.log('✓ 真实tracker：range按[start,end)清事件/OCR/语义评估并保留范围外内容；range/all清正文host但保留即时安全屏蔽')
} finally {
  configureActivityHistoryPersistence(null)
  clearActivityHistoryEvidence()
}
console.log('\n隐私回归测试通过（内存side-effect stubs，无collector/截图/用户数据）')
