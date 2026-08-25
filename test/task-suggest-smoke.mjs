import { rankTaskSuggestions } from '../src/shared/task-suggest.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const NOW = '2026-08-25T10:00'
const base = {
  itemType: 'other',
  belongsToUser: 'yes',
  belongingReason: null,
  userRole: 'unclear',
  location: null,
  confidence: 0.9,
  suggestedAction: 'add',
  evidence: [],
  notes: [],
  duplicateOf: null,
  feedback: null,
  sourceId: null,
  createdAt: '2026-08-20T09:00',
  updatedAt: '2026-08-20T09:00'
}
const task = (id, patch) => ({
  ...base,
  id,
  title: id,
  status: 'scheduled',
  priority: 'unknown',
  startTime: null,
  dueTime: null,
  ...patch
})

const tiers = rankTaskSuggestions(
  [
    task('expired-meeting', { startTime: '2026-08-23T15:00' }),
    task('overdue-deadline', { status: 'overdue', dueTime: '2026-08-24T18:00' }),
    task('due-in-2h', { dueTime: '2026-08-25T11:30' }),
    task('today-low', { dueTime: '2026-08-25T22:00', priority: 'low' }),
    task('tomorrow-high', { dueTime: '2026-08-26T10:00', priority: 'high' }),
    task('next-week', { startTime: '2026-09-05T10:00' }),
    task('unscheduled-inprogress', { status: 'in_progress' }),
    task('done-task', { status: 'done', dueTime: '2026-08-25T12:00' }),
    task('ignored-task', { status: 'ignored', dueTime: '2026-08-25T12:00' })
  ],
  NOW
)

const flat = tiers.flatMap((t) => t.items)
const rankOf = (id) => flat.findIndex((s) => s.task.id === id)
const byId = (id) => flat.find((s) => s.task.id === id)

check('完成/已忽略的任务不进建议', !byId('done-task') && !byId('ignored-task'))
check('已过期/已延期排最前', rankOf('overdue-deadline') <= 1 && rankOf('expired-meeting') <= 1)
check('纯开始时间的过期任务也被建议（不会漏掉「开过的会」）', !!byId('expired-meeting'))
check(
  '过期任务带天数理由',
  byId('expired-meeting').reasons.some((r) => r.includes('已过期')) &&
    byId('overdue-deadline').reasons.some((r) => r.includes('过期') || r.includes('延期'))
)
check('临近截止排在今天低优先级之前', rankOf('due-in-2h') < rankOf('today-low'))
check(
  '高优先级能把明天顶到今天低优先级之前',
  byId('tomorrow-high').score > byId('today-low').score
)
check('明天任务理由按日历日判定', byId('tomorrow-high').reasons.some((r) => r.startsWith('明天')))
check('未排期任务带待安排理由', byId('unscheduled-inprogress').reasons.includes('待安排时间'))
check('进行中有加分理由', byId('unscheduled-inprogress').reasons.includes('进行中'))
check('远期任务落在最后一档', tiers.at(-1).items.some((s) => s.task.id === 'next-week'))
check(
  '分档标题只出现非空档',
  tiers.every((t) => t.items.length > 0) &&
    tiers.length >= 2 &&
    tiers[0].title === '马上处理'
)
check(
  '空输入返回空数组',
  rankTaskSuggestions([], NOW).length === 0
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
