// 纯函数单测：关键词匹配 + 选最优。运行：npm run test:screen
import { matchKeywords, DEFAULT_SCREEN_KEYWORDS } from '../src/shared/keywords.ts'
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

// ---- matchKeywords ----
check('命中单个关键词', matchKeywords('明天下午开会议', ['会议']).join() === '会议')
check(
  '多关键词去重命中',
  JSON.stringify(matchKeywords('会议和考试通知，考试很重要', ['会议', '考试'])) ===
    JSON.stringify(['会议', '考试'])
)
check('英文大小写不敏感', matchKeywords('Project DEADLINE today', ['deadline']).join() === 'deadline')
check('未命中返回空数组', matchKeywords('今天天气不错', ['会议', '考试']).length === 0)
check('默认词表非空', DEFAULT_SCREEN_KEYWORDS.length > 0)
check(
  '默认词表含会议/日程/考试',
  ['会议', '日程', '考试'].every((k) => DEFAULT_SCREEN_KEYWORDS.includes(k))
)

// ---- pickBest ----
check('空数组返回 null', pickBest([]) === null)
check('全部 belongs=no 返回 null', pickBest([mkItem({ belongs_to_user: 'no', title: 'x' })]) === null)
check(
  '挑置信度最高的 yes',
  pickBest([
    mkItem({ title: 'low', confidence: 0.5 }),
    mkItem({ title: 'high', confidence: 0.95 })
  ])?.title === 'high'
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
if (failed) process.exit(1)
