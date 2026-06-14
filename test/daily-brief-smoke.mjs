// 纯函数单测：每日简报 buildDailyBrief。运行：npm run test:brief
import { buildDailyBrief } from '../src/shared/daily-brief.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const NOW = new Date(2026, 5, 14, 9, 0) // 2026-06-14 09:00 本地
function mk(o) {
  return {
    id: 'x',
    sourceId: null,
    title: 't',
    itemType: 'reminder',
    belongsToUser: 'yes',
    belongingReason: '',
    userRole: 'owner',
    startTime: null,
    dueTime: null,
    location: null,
    priority: 'unknown',
    confidence: 0.9,
    suggestedAction: 'confirm',
    evidence: [],
    notes: [],
    duplicateOf: null,
    status: 'scheduled',
    feedback: null,
    createdAt: '',
    updatedAt: '',
    ...o
  }
}

// 空 / 无相关
check('无任务 → count 0 文案', buildDailyBrief([], NOW).count === 0)
check('未来任务不计入今天', buildDailyBrief([mk({ id: 'a', dueTime: '2026-06-20T10:00' })], NOW).count === 0)
check('已完成不计入', buildDailyBrief([mk({ id: 'b', status: 'done', dueTime: '2026-06-14T10:00' })], NOW).count === 0)
check('非本人不计入', buildDailyBrief([mk({ id: 'c', belongsToUser: 'uncertain', dueTime: '2026-06-14T10:00' })], NOW).count === 0)
check('无时间不计入', buildDailyBrief([mk({ id: 'd' })], NOW).count === 0)

// 今天 / 逾期
const r1 = buildDailyBrief([mk({ id: 'today', dueTime: '2026-06-14T14:00' })], NOW)
check('今天截止 → count 1', r1.count === 1 && r1.topTaskId === 'today')
check('今天文案含时间', r1.message.includes('今天 14:00') && r1.message.includes('1 件'))

const r2 = buildDailyBrief([mk({ id: 'od', status: 'overdue', dueTime: '2026-06-10T08:00' })], NOW)
check('逾期任务计入并标已逾期', r2.count === 1 && r2.message.includes('已逾期'))

// 紧急度排序：最早时间优先
const r3 = buildDailyBrief(
  [
    mk({ id: 'late', dueTime: '2026-06-14T18:00' }),
    mk({ id: 'early', dueTime: '2026-06-14T09:30' }),
    mk({ id: 'over', status: 'overdue', dueTime: '2026-06-12T08:00' })
  ],
  NOW
)
check('多项 → count 3', r3.count === 3)
check('最紧急取最早（逾期项）', r3.topTaskId === 'over')

// 同时间按优先级
const r4 = buildDailyBrief(
  [
    mk({ id: 'lo', dueTime: '2026-06-14T10:00', priority: 'low' }),
    mk({ id: 'hi', dueTime: '2026-06-14T10:00', priority: 'high' })
  ],
  NOW
)
check('同时间 → 高优先级在前', r4.topTaskId === 'hi')

// 用 startTime 兜底（无 dueTime）
check('仅 startTime 也计入', buildDailyBrief([mk({ id: 's', startTime: '2026-06-14T11:00' })], NOW).count === 1)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
