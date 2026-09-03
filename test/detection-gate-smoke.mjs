// 纯函数单测：屏幕感知候选的入队门槛与「完成即撤」（issue #128）。
// 运行：node test/run.mjs detection-gate
import {
  detectionQueueDecision,
  looksCompleted,
  TIMED_MIN_CONFIDENCE,
  TIMELESS_MIN_CONFIDENCE
} from '../src/shared/detection-gate.ts'

function mkItem(o) {
  return {
    title: 't',
    item_type: 'other',
    belongs_to_user: 'yes',
    belonging_reason: '',
    user_role: 'unclear',
    start_time: null,
    due_time: null,
    location: null,
    priority: 'unknown',
    confidence: 0.9,
    suggested_action: 'confirm',
    evidence: [],
    notes: [],
    duplicate_of: null,
    ...o
  }
}

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- 入队门槛：模型的判断要被采纳 ----
check(
  '模型说 ignore → 存档',
  detectionQueueDecision(mkItem({ suggested_action: 'ignore' }), true) === 'archive'
)
check(
  '明确是别人的事 → 存档',
  detectionQueueDecision(mkItem({ belongs_to_user: 'no' }), true) === 'archive'
)

// ---- 有时间：时间本身是强信号，门槛低 ----
check(
  '有时间 + 置信度达标 → 入队',
  detectionQueueDecision(mkItem({ confidence: TIMED_MIN_CONFIDENCE }), true) === 'queue'
)
check(
  '有时间但置信度不足 → 存档',
  detectionQueueDecision(mkItem({ confidence: TIMED_MIN_CONFIDENCE - 0.01 }), true) === 'archive'
)

// ---- 无时间：#128 的噪声全在这一类，门槛更高 ----
check(
  '无时间 + 中等置信度 → 存档（#128 的 37 条就是这种）',
  detectionQueueDecision(mkItem({ confidence: 0.6 }), false) === 'archive'
)
check(
  '无时间但模型很有把握 → 仍然入队',
  detectionQueueDecision(mkItem({ confidence: TIMELESS_MIN_CONFIDENCE }), false) === 'queue'
)
check(
  '无时间的门槛严于有时间',
  TIMELESS_MIN_CONFIDENCE > TIMED_MIN_CONFIDENCE
)
check(
  '同一条候选：有时间入队、无时间存档',
  detectionQueueDecision(mkItem({ confidence: 0.6 }), true) === 'queue' &&
    detectionQueueDecision(mkItem({ confidence: 0.6 }), false) === 'archive'
)

// ---- 完成即撤 ----
check(
  '复选框已勾 → 判定完成',
  looksCompleted('查 21b 和 26b 的 eval 状态', '- [x] 查 21b 和 26b 的 eval 状态')
)
check(
  '复选框未勾 → 不撤',
  !looksCompleted('查 21b 和 26b 的 eval 状态', '- [ ] 查 21b 和 26b 的 eval 状态')
)
check(
  '对钩标记 → 判定完成',
  looksCompleted('实现 Ghostty 选中文本自动复制', '✓ 实现 Ghostty 选中文本自动复制')
)
check(
  '中文「已完成」→ 判定完成',
  looksCompleted('把组会笔记补上主线结论段落', '已完成：把组会笔记补上主线结论段落')
)
check(
  '标题在屏幕上但没有完成标记 → 不撤',
  !looksCompleted('把组会笔记补上主线结论段落', '把组会笔记补上主线结论段落')
)
check(
  '完成标记在别的行 → 不撤',
  !looksCompleted('查 21b 和 26b 的 eval 状态', '[x] 别的事\n查 21b 和 26b 的 eval 状态')
)
check(
  '标题没出现在屏幕上 → 不撤',
  !looksCompleted('完全不相干的一件事', '- [x] 别的事')
)
check('标题太短 → 锚点不可靠，不撤', !looksCompleted('开会', '- [x] 开会'))
check('屏幕文字为空 → 不撤', !looksCompleted('把组会笔记补上主线结论段落', ''))
check(
  'OCR 空格错位仍能命中（比对前抹平空白）',
  looksCompleted('把组会笔记补上主线结论段落', '- [x] 把 组会 笔记 补上 主线结论段落')
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
