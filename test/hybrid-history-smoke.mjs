import assert from 'node:assert/strict'
import {
  assessSemanticCompleteness,
  contextKey,
  decideOcrTrigger,
  hybridSegmentFromActivity
} from '../src/shared/hybrid-history.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const complete = assessSemanticCompleteness({
  appName: 'Code',
  bundleId: 'com.microsoft.VSCode',
  windowTitle: 'activity-tracker.ts',
  focusedRole: 'AXTextField',
  safeLabel: 'Editor',
  eventKind: 'ax_focus_changed',
  eventSource: 'accessibility'
})
check('完整上下文达到 complete', complete.semanticLevel === 'complete' && complete.score === 100)
check('缺窗口上下文降为 partial', assessSemanticCompleteness({ appName: 'Code' }).semanticLevel === 'partial')
check(
  '无 Accessibility 时 App+窗口也降为 partial',
  assessSemanticCompleteness({ appName: 'Code', windowTitle: 'file.ts', observerHealthy: false }).semanticLevel === 'partial'
)
check('空上下文为 empty', assessSemanticCompleteness({}).semanticLevel === 'empty')
check('私密状态绝对抑制', assessSemanticCompleteness({ appName: 'Safari', privacyState: 'private' }).score === 0)
check('上下文 key 稳定归一', contextKey({ appName: ' Code ', bundleId: 'COM.X', windowTitle: ' A  B ' }) === 'code|com.x|a b')

const base = {
  hybridEnabled: true,
  semantic: assessSemanticCompleteness({ appName: 'Code' }),
  nowMs: 100_000,
  active: true,
  screenAllowed: true,
  highValueEvent: false,
  consecutivePartialCount: 1,
  observerHealthy: true,
  observerFailureCount: 0,
  lastOcrAtMs: null,
  lastOcrContextKey: null,
  contextKey: 'code||',
  hardFallback: false
}
check('partial 首次不 OCR', !decideOcrTrigger(base).run)
check('partial 连续第二次触发 retry', decideOcrTrigger({ ...base, consecutivePartialCount: 2, contextKey: 'code|window|two' }).reason === 'partial_retry')
check('高价值 partial 立即 OCR', decideOcrTrigger({ ...base, highValueEvent: true }).reason === 'partial_high_value')
check('empty 只在兜底时 OCR', decideOcrTrigger({ ...base, semantic: assessSemanticCompleteness({}), hardFallback: true }).reason === 'empty_active')
check('全局 45 秒限频', !decideOcrTrigger({ ...base, highValueEvent: true, lastOcrAtMs: 90_001 }).run)
check('observer 失败只允许一次补证', decideOcrTrigger({ ...base, observerHealthy: false, observerFailureCount: 1, highValueEvent: false }).reason === 'observer_failure')
check(
  '仅未授权 Accessibility 按 partial 矩阵降级',
  decideOcrTrigger({
    ...base,
    semantic: assessSemanticCompleteness({ appName: 'Code', windowTitle: 'file.ts', observerHealthy: false }),
    observerHealthy: false,
    observerFailureCount: 0,
    consecutivePartialCount: 1
  }).reason === 'complete'
)
check('observer 连续失败不恢复周期截图', !decideOcrTrigger({ ...base, observerHealthy: false, observerFailureCount: 2, highValueEvent: true }).run)
check('secure/privacy 永不 OCR', !decideOcrTrigger({ ...base, semantic: assessSemanticCompleteness({ privacyState: 'secure' }), hardFallback: true }).run)
check('legacy 开关保留旧事件触发', decideOcrTrigger({ ...base, hybridEnabled: false, highValueEvent: false }).reason === 'legacy_event')

const segment = {
  id: 'activity-10m-test',
  bucket: { kind: '10m', startMs: 0, endMs: 600_000, startIso: '1970-01-01T00:00:00.000Z', endIso: '1970-01-01T00:10:00.000Z' },
  eventCount: 2,
  meaningfulEventCount: 1,
  firstEventAtMs: 1,
  lastEventAtMs: 2,
  apps: ['Code'],
  windowTitles: ['file.ts'],
  summary: 'Apps: Code; Windows: file.ts; Meaningful events: 1/2'
}
const hybrid = hybridSegmentFromActivity(segment, [complete, base.semantic], [])
check('片段带语义计数', hybrid.semanticCompleteCount === 1 && hybrid.semanticPartialCount === 1)
check('片段触发原因确定性排序', JSON.stringify(hybrid.triggerReasons) === JSON.stringify([...new Set([...complete.reasonCodes, ...base.semantic.reasonCodes])].sort()))

assert.equal(failed, 0)
console.log('\nAll hybrid-history tests passed')
