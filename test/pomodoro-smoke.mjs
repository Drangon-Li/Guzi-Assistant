// 纯函数单测：专注插件的相位推进、暂停计时与统计。运行：npm run test pomodoro
//
// 重点卡住暂停的计时口径：暂停期间读数必须冻住，恢复后把这段时长累加进 pausedMs，
// 且全程按 wall clock 算——合盖两小时再打开，剩余时间不能凭空少两小时。
import {
  DEFAULT_PREFS,
  RANGE_DAYS,
  actualMinutes,
  breakdownByTask,
  byHour,
  byWeekday,
  dayStats,
  focusLabel,
  formatCountdown,
  goalCurrentOf,
  goalLabel,
  longestConsecutive,
  normalizeGoal,
  nextPhase,
  normalizePrefs,
  pausedMsAfterResume,
  rangeByTask,
  rangeStats,
  remainingSeconds
} from '../src/shared/pomodoro.ts'

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 偏好归一 ----------
check('空补默认', eq(normalizePrefs({}), DEFAULT_PREFS))
check('越界回落默认', normalizePrefs({ focusMin: 0 }).focusMin === DEFAULT_PREFS.focusMin)
check('超上限回落默认', normalizePrefs({ focusMin: 999 }).focusMin === DEFAULT_PREFS.focusMin)
check('非数字回落默认', normalizePrefs({ focusMin: 'abc' }).focusMin === DEFAULT_PREFS.focusMin)
check('合法值保留', normalizePrefs({ focusMin: 50 }).focusMin === 50)
check('小数取整', normalizePrefs({ focusMin: 25.6 }).focusMin === 26)
check('长休息轮次下限是 2', normalizePrefs({ roundsBeforeLongBreak: 1 }).roundsBeforeLongBreak === 4)
check('每日目标可设轮数', eq(normalizePrefs({ dailyGoal: { kind: 'rounds', value: 12 } }).dailyGoal, { kind: 'rounds', value: 12 }))
check('每日目标可设时长', eq(normalizePrefs({ dailyGoal: { kind: 'minutes', value: 120 } }).dailyGoal, { kind: 'minutes', value: 120 }))

// ---------- 目标口径 ----------
// 老版本 dailyGoal 存的是一个裸数字（轮数）；升级不该把用户改过的目标悄悄重置
check('老版本的裸数字按轮数读进来', eq(normalizeGoal(6), { kind: 'rounds', value: 6 }))
check('老版本越界的裸数字回落默认', eq(normalizeGoal(999), { kind: 'rounds', value: 8 }))
check('缺省是 8 轮', eq(normalizeGoal(undefined), { kind: 'rounds', value: 8 }))
check('坏数据回落默认', eq(normalizeGoal('abc'), { kind: 'rounds', value: 8 }))
check('时长目标保留', eq(normalizeGoal({ kind: 'minutes', value: 90 }), { kind: 'minutes', value: 90 }))
check('时长目标越界回落到 120 分钟', eq(normalizeGoal({ kind: 'minutes', value: 5 }), { kind: 'minutes', value: 120 }))
check('未知 kind 当轮数', normalizeGoal({ kind: 'ghost', value: 5 }).kind === 'rounds')
check('轮数目标的文案', goalLabel({ kind: 'rounds', value: 8 }) === '8 轮')
check('时长目标的文案', goalLabel({ kind: 'minutes', value: 120 }) === '2 小时')
check('轮数口径取轮数', goalCurrentOf({ kind: 'rounds', value: 8 }, 3, 75) === 3)
check('时长口径取分钟', goalCurrentOf({ kind: 'minutes', value: 120 }, 3, 75) === 75)
check('autoStart 非布尔回落', normalizePrefs({ autoStart: 'yes' }).autoStart === false)
check('autoStart 可设 true', normalizePrefs({ autoStart: true }).autoStart === true)

// ---------- 相位推进 ----------
const P = DEFAULT_PREFS // focus 25 / short 5 / long 15 / 每 4 轮
check('休息完回到专注', eq(nextPhase('break', 3, P), { kind: 'focus', minutes: 25, long: false }))
check('第 1 轮专注后是短休息', eq(nextPhase('focus', 1, P), { kind: 'break', minutes: 5, long: false }))
check('第 3 轮后仍是短休息', nextPhase('focus', 3, P).long === false)
check('第 4 轮后是长休息', eq(nextPhase('focus', 4, P), { kind: 'break', minutes: 15, long: true }))
check('第 8 轮后又是长休息', nextPhase('focus', 8, P).long === true)
check('第 5 轮后回到短休息', nextPhase('focus', 5, P).long === false)
check('轮数为 0 时不给长休息', nextPhase('focus', 0, P).long === false)

// ---------- 倒计时格式 ----------
check('分秒', formatCountdown(90) === '01:30')
check('补零', formatCountdown(5) === '00:05')
check('零', formatCountdown(0) === '00:00')
check('负数夹到零', formatCountdown(-10) === '00:00')
check('超过一小时带时位', formatCountdown(3725) === '1:02:05')

// ---------- wall clock 计时 ----------
const start = '2026-08-28T10:00:00'
const base = new Date(start).getTime()
const run = (o = {}) => ({ startAt: start, minutes: 25, pausedMs: 0, pausedAt: null, ...o })

check('刚开始时剩满', remainingSeconds(run(), base) === 1500)
check('过了 10 分钟', remainingSeconds(run(), base + 600_000) === 900)
check('走完归零', remainingSeconds(run(), base + 1_500_000) === 0)
check('超时也不给负数（合盖两小时再打开）', remainingSeconds(run(), base + 7_200_000) === 0)
check('非法起始时刻返回 0', remainingSeconds(run({ startAt: '不是时刻' }), base) === 0)
check('累计暂停会把剩余往回补', remainingSeconds(run({ pausedMs: 300_000 }), base + 600_000) === 1200)

// ---------- 暂停 ----------
const paused = run({ pausedAt: '2026-08-28T10:10:00' })
check(
  '暂停中读数冻在进入暂停的那一刻',
  remainingSeconds(paused, base + 600_000) === 900 && remainingSeconds(paused, base + 3_600_000) === 900
)
check('暂停 5 分钟后恢复，累计暂停 = 5 分钟', pausedMsAfterResume(paused, base + 900_000) === 300_000)
check('没在暂停时恢复不改累计', pausedMsAfterResume(run({ pausedMs: 42 }), base) === 42)
check(
  '恢复后剩余接着之前走（暂停那 5 分钟不算）',
  remainingSeconds(run({ pausedMs: 300_000 }), base + 900_000) === 900
)
check('暂停时刻非法则不动累计', pausedMsAfterResume(run({ pausedMs: 7, pausedAt: '坏' }), base) === 7)

// ---------- 实际投入 ----------
check('实际投入扣掉暂停', actualMinutes(run({ pausedMs: 300_000 }), base + 900_000) === 10)
check('没暂停就是全程', actualMinutes(run(), base + 600_000) === 10)
check('暂停中结算也扣掉当前这段', actualMinutes(paused, base + 1_200_000) === 10)

// ---------- 统计 ----------
const s = (o) => ({
  id: 'x',
  startAt: '2026-08-28T10:00:00',
  endAt: '2026-08-28T10:25:00',
  minutes: 25,
  kind: 'focus',
  completed: true,
  pausedMs: 0,
  pausedAt: null,
  blockId: null,
  taskId: null,
  taskTitle: null,
  note: null,
  ...o
})
const sessions = [
  s({}),
  s({ startAt: '2026-08-28T11:00:00', minutes: 30, taskId: 't1', taskTitle: '看论文' }),
  s({ startAt: '2026-08-28T12:00:00', completed: false }),
  s({ startAt: '2026-08-28T13:00:00', kind: 'break', minutes: 5 }),
  s({ startAt: '2026-08-27T10:00:00' })
]
const today = dayStats(sessions, '2026-08-28', { kind: 'rounds', value: 4 })
check('只数完成的专注轮', today.rounds === 2)
check('休息不计入专注时长', today.focusMinutes === 55)
check('中途放弃单独计数', today.abandoned === 1)
check('距目标还差', today.remainingToGoal === 2)
check('目标进度', today.goalProgress === 0.5)
check('达标后不给负数', dayStats(sessions, '2026-08-28', { kind: 'rounds', value: 1 }).remainingToGoal === 0)
check('达标后进度封顶 1', dayStats(sessions, '2026-08-28', { kind: 'rounds', value: 1 }).goalProgress === 1)

// 同一天、同一批数据，换成时长口径后进度完全不同——这正是要支持两种口径的理由
const byMinutes = dayStats(sessions, '2026-08-28', { kind: 'minutes', value: 110 })
check('时长口径下已完成量是分钟数', byMinutes.goalCurrent === 55)
check('时长口径下还差的也是分钟数', byMinutes.remainingToGoal === 55)
check('时长口径下的进度', byMinutes.goalProgress === 0.5)
check('目标带回给界面用于决定单位', byMinutes.goal.kind === 'minutes')
check('老版本裸数字传进 dayStats 也能用', dayStats(sessions, '2026-08-28', 4).remainingToGoal === 2)
check('别的日期不混入', dayStats(sessions, '2026-08-27').rounds === 1)
check('没有记录的日期全零', dayStats(sessions, '2026-08-01').rounds === 0)
check('非法 startAt 被跳过', dayStats([s({ startAt: '坏数据' })], '2026-08-28').rounds === 0)

// ---------- 按任务聚合 ----------
const bt = breakdownByTask(sessions, '2026-08-28')
check('按时长降序', eq(bt.map((r) => r.label), ['看论文', '未关联任务']))
check('关联任务的时长', bt[0].minutes === 30 && bt[0].rounds === 1)
check('没关联的归到「未关联任务」而不是丢掉', bt[1].minutes === 25)
check('未完成的不进聚合', bt.reduce((n, r) => n + r.rounds, 0) === 2)
check('空日期返回空', breakdownByTask(sessions, '2026-08-01').length === 0)

// ---------- 区间统计 ----------
const range = [
  s({ startAt: '2026-08-20T09:00:00', minutes: 25 }),
  s({ startAt: '2026-08-20T10:00:00', minutes: 25 }),
  s({ startAt: '2026-08-21T09:00:00', minutes: 60, taskId: 't1', taskTitle: '写论文' }),
  s({ startAt: '2026-08-22T14:00:00', minutes: 25, completed: false }),
  s({ startAt: '2026-08-23T09:00:00', minutes: 25 }),
  s({ startAt: '2026-08-10T09:00:00', minutes: 100 }) // 区间外
]
const rs = rangeStats(range, '2026-08-20', '2026-08-26', { kind: 'rounds', value: 2 })
check('区间外的不计入', rs.rounds === 4)
check('总时长', rs.focusMinutes === 135)
check('放弃单独计数', rs.abandoned === 1)
check('有专注的天数（放弃的那天不算）', rs.activeDays === 3)
check('达标天数（目标 2 轮）', rs.goalDays === 1)
check(
  '换成时长口径后达标天数按分钟判（≥50 分钟的有 2 天）',
  rangeStats(range, '2026-08-20', '2026-08-26', { kind: 'minutes', value: 50 }).goalDays === 2
)
check('日均按活跃天算，不把没开机的日子摊进去', rs.avgMinutesPerActiveDay === Math.round(135 / 3))
check('完成率', Math.abs(rs.completionRate - 4 / 5) < 1e-9)
check('最投入的一天', rs.bestDay?.date === '2026-08-21' && rs.bestDay?.minutes === 60)
check('空区间不炸', rangeStats([], '2026-08-01', '2026-08-07').rounds === 0)
check('空区间 bestDay 为 null', rangeStats([], '2026-08-01', '2026-08-07').bestDay === null)

check('最长连续段', longestConsecutive(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-10']) === 3)
check('跨月连续', longestConsecutive(['2026-08-31', '2026-09-01']) === 2)
check('去重后再算', longestConsecutive(['2026-08-01', '2026-08-01']) === 1)
check('空数组 → 0', longestConsecutive([]) === 0)

const hours = byHour(range, '2026-08-20', '2026-08-26')
check('按小时分布：9 点最多', hours[9] === 110)
check('按小时分布：10 点', hours[10] === 25)
check('未完成的不进小时分布', hours[14] === 0)
const wd = byWeekday(range, '2026-08-20', '2026-08-26')
check('按星期分布长度 7', wd.length === 7)
check('按星期分布总和等于总时长', wd.reduce((a, b) => a + b, 0) === 135)

const rbt = rangeByTask(range, '2026-08-20', '2026-08-26')
check('未关联的归到一起（75 分钟，比写论文多，所以排前面）', rbt[0].label === '未关联任务' && rbt[0].minutes === 75)
check('区间内按任务聚合，按时长降序', rbt[1].label === '写论文' && rbt[1].minutes === 60)
check('limit 生效', rangeByTask(range, '2026-08-20', '2026-08-26', 1).length === 1)
check('三档天数', RANGE_DAYS.week === 7 && RANGE_DAYS.month === 30 && RANGE_DAYS.year === 365)

check('时长人话：时+分', focusLabel(125) === '2 小时 5 分钟')
check('时长人话：整小时', focusLabel(120) === '2 小时')
check('时长人话：不足一小时', focusLabel(45) === '45 分钟')
check('零说「还没开始」', focusLabel(0) === '还没开始')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
