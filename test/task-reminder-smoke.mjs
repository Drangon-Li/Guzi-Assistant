// 纯函数单测：任务提醒判定 dueReminders。运行：npm run test:reminder
import { dueReminders, reminderWhenLabel } from '../src/shared/task-reminder.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const NOW = new Date(2026, 7, 24, 14, 0) // 2026-08-24 14:00 本地
const OPTS = { enabled: true, defaultOffsetMin: 5, catchupWindowMin: 120 }

function mk(o) {
  return {
    id: 'x',
    title: 't',
    startTime: null,
    dueTime: null,
    status: 'scheduled',
    belongsToUser: 'yes',
    priority: 'unknown',
    remindOffsetMin: null,
    remindedAt: null,
    snoozedUntil: null,
    ...o
  }
}
const run = (task, opts = OPTS) => dueReminders([mk(task)], opts, NOW)
const fires = (task, opts) => run(task, opts).length === 1

// ---- 总开关 ----
check('总开关关 → 空', dueReminders([mk({ startTime: '2026-08-24T14:05' })], { ...OPTS, enabled: false }, NOW).length === 0)

// ---- 提前量 ----
const ahead = run({ startTime: '2026-08-24T14:05' })
check('默认提前 5 分钟 → 到点命中', ahead.length === 1)
check('目标时刻 = 事件时刻 - 提前量', ahead[0]?.targetIso === '2026-08-24T14:00')
check('事件时刻原样带出', ahead[0]?.eventIso === '2026-08-24T14:05')
check('提前命中 kind=ahead', ahead[0]?.kind === 'ahead')
check('还没到提醒时刻 → 不提醒', !fires({ startTime: '2026-08-24T14:30' }))

// ---- 任务级覆盖 ----
check('任务级提前 30 分钟生效', fires({ startTime: '2026-08-24T14:30', remindOffsetMin: 30 }))
check('任务级提前 0 → 到点才提醒', !fires({ startTime: '2026-08-24T14:05', remindOffsetMin: 0 }))
const ontime = run({ startTime: '2026-08-24T14:00', remindOffsetMin: 0 })
check('正点命中 kind=ontime', ontime[0]?.kind === 'ontime')
check('任务级 -1 → 该任务不提醒', !fires({ startTime: '2026-08-24T14:05', remindOffsetMin: -1 }))

// ---- 幂等 ----
check('已提醒过同一目标时刻 → 不重复', !fires({ startTime: '2026-08-24T14:05', remindedAt: '2026-08-24T14:00' }))
check('remindedAt 为旧目标 → 重新命中', fires({ startTime: '2026-08-24T14:05', remindedAt: '2026-08-24T13:00' }))
check('复位后重新命中', fires({ startTime: '2026-08-24T14:05', remindedAt: null }))

// ---- 状态 / 归属门 ----
for (const status of ['pending', 'done', 'ignored'])
  check(`${status} 不提醒`, !fires({ startTime: '2026-08-24T14:05', status }))
for (const status of ['not_started', 'scheduled', 'in_progress', 'overdue'])
  check(`${status} 提醒`, fires({ startTime: '2026-08-24T14:05', status }))
for (const belongs of ['no', 'uncertain'])
  check(`belongsToUser=${belongs} 不提醒`, !fires({ startTime: '2026-08-24T14:05', belongsToUser: belongs }))

// ---- 事件时刻口径 ----
const both = run({ startTime: '2026-08-24T14:05', dueTime: '2026-08-25T10:00' })
check('startTime 优先于 dueTime', both.length === 1 && both[0].eventIso === '2026-08-24T14:05')
check('仅 dueTime 也生效', fires({ dueTime: '2026-08-24T14:05' }))
check('两者皆空 → 不提醒', !fires({}))

// ---- 只有日期无时分 ----
const dateOnly = dueReminders([mk({ startTime: '2026-08-24' })], { ...OPTS, catchupWindowMin: 600 }, NOW)
check('只有日期 → 按当天 09:00', dateOnly[0]?.eventIso === '2026-08-24T09:00')

// ---- 逾期补提醒窗口 ----
const catchup = run({ startTime: '2026-08-24T13:00', remindOffsetMin: 0 })
check('1 小时前逾期 → 补提醒', catchup.length === 1)
check('逾期命中 kind=catchup', catchup[0]?.kind === 'catchup')
check('3.5 小时前逾期 → 超窗不补', !fires({ startTime: '2026-08-24T10:30', remindOffsetMin: 0 }))

// ---- 稍后提醒 ----
check('snooze 未到 → 不提醒', !fires({ startTime: '2026-08-24T13:00', snoozedUntil: '2026-08-24T15:00' }))
const snoozed = run({ startTime: '2026-08-24T13:00', snoozedUntil: '2026-08-24T13:50' })
check('snooze 已到 → 提醒', snoozed.length === 1)
check('snooze 目标时刻 = snoozedUntil', snoozed[0]?.targetIso === '2026-08-24T13:50')
check('snooze 命中 kind=snooze', snoozed[0]?.kind === 'snooze')
check(
  'snooze 不受 catchup 窗口限制',
  fires({ startTime: '2026-08-24T09:00', snoozedUntil: '2026-08-24T10:00' })
)
check(
  'snooze 已兑现 → 不重复提醒',
  !fires({ startTime: '2026-08-24T13:00', snoozedUntil: '2026-08-24T13:50', remindedAt: '2026-08-24T13:50' })
)
check(
  '再次 snooze 到更晚 → 重新兑现',
  fires({ startTime: '2026-08-24T13:00', snoozedUntil: '2026-08-24T13:55', remindedAt: '2026-08-24T13:50' })
)

// ---- 排序 ----
const sorted = dueReminders(
  [
    mk({ id: 'late', startTime: '2026-08-24T14:05' }),
    mk({ id: 'early', startTime: '2026-08-24T13:10', remindOffsetMin: 0 }),
    mk({ id: 'mid', startTime: '2026-08-24T13:40', remindOffsetMin: 0 })
  ],
  OPTS,
  NOW
)
check('全部命中不截断', sorted.length === 3)
check('按事件时刻升序', sorted.map((r) => r.taskId).join(',') === 'early,mid,late')

const samePriority = dueReminders(
  [
    mk({ id: 'lo', startTime: '2026-08-24T14:05', priority: 'low' }),
    mk({ id: 'hi', startTime: '2026-08-24T14:05', priority: 'high' })
  ],
  OPTS,
  NOW
)
check('同时刻按优先级', samePriority[0]?.taskId === 'hi')

// ---- 提醒文案 ----
const label = (eventIso, kind) => reminderWhenLabel({ eventIso, kind }, NOW)
check('提前 → N 分钟后 + 时刻', label('2026-08-24T14:10', 'ahead') === '10 分钟后 · 14:10')
check('提前超过 1 小时 → 按小时', label('2026-08-24T16:00', 'ahead') === '2 小时后 · 16:00')
check('正点 → 现在 + 时刻', label('2026-08-24T14:00', 'ontime') === '现在 · 14:00')
check('逾期 → 已逾期 + 时长', label('2026-08-24T12:00', 'catchup') === '已逾期 2 小时')
check('稍后 → 标出原定时刻', label('2026-08-24T13:00', 'snooze') === '稍后提醒 · 原定 13:00')
check(
  '只有日期 → 文案也按 09:00 归一',
  reminderWhenLabel({ eventIso: '2026-08-24', kind: 'ontime' }, new Date(2026, 7, 24, 9, 0)) === '现在 · 09:00'
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
