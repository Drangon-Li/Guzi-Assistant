// 纯函数单测：选最优（pickBest）。运行：npm run test:screen
import { pickBest, SUGGEST_MIN_CONFIDENCE } from '../src/shared/suggest.ts'

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

check('空数组返回 null', pickBest([]) === null)
check('全部 belongs=no 返回 null', pickBest([mkItem({ belongs_to_user: 'no', title: 'x' })]) === null)
check(
  '挑置信度最高的 yes',
  pickBest([mkItem({ title: 'low', confidence: 0.5 }), mkItem({ title: 'high', confidence: 0.95 })])
    ?.title === 'high'
)
check(
  'yes 优先于 uncertain（即使 uncertain 置信度更高）',
  pickBest([
    mkItem({ title: 'unc', belongs_to_user: 'uncertain', confidence: 0.99 }),
    mkItem({ title: 'yes', belongs_to_user: 'yes', confidence: 0.6 })
  ])?.title === 'yes'
)
check(
  '最优低于阈值返回 null',
  pickBest([mkItem({ confidence: SUGGEST_MIN_CONFIDENCE - 0.1 })]) === null
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
