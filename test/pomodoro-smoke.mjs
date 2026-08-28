// 纯函数单测：专注插件的相位推进、暂停计时与统计。运行：npm run test pomodoro
//
// 重点卡住暂停的计时口径：暂停期间读数必须冻住，恢复后把这段时长累加进 pausedMs，
// 且全程按 wall clock 算——合盖两小时再打开，剩余时间不能凭空少两小时。
import {
  DEFAULT_PREFS,
  actualMinutes,
  breakdownByTask,
  dayStats,
  focusLabel,
  formatCountdown,
  nextPhase,
  normalizePrefs,
  pausedMsAfterResume,
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
check('每日目标可设', normalizePrefs({ dailyGoal: 12 }).dailyGoal === 12)
check('每日目标越界回落', normalizePrefs({ dailyGoal: 0 }).dailyGoal === DEFAULT_PREFS.dailyGoal)
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
const today = dayStats(sessions, '2026-08-28', 4)
check('只数完成的专注轮', today.rounds === 2)
check('休息不计入专注时长', today.focusMinutes === 55)
check('中途放弃单独计数', today.abandoned === 1)
check('距目标还差', today.remainingToGoal === 2)
check('目标进度', today.goalProgress === 0.5)
check('达标后不给负数', dayStats(sessions, '2026-08-28', 1).remainingToGoal === 0)
check('达标后进度封顶 1', dayStats(sessions, '2026-08-28', 1).goalProgress === 1)
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

check('时长人话：时+分', focusLabel(125) === '2 小时 5 分钟')
check('时长人话：整小时', focusLabel(120) === '2 小时')
check('时长人话：不足一小时', focusLabel(45) === '45 分钟')
check('零说「还没开始」', focusLabel(0) === '还没开始')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
