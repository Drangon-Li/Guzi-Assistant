// 纯函数单测：专注插件的相位推进、倒计时与统计。运行：npm run test pomodoro
import {
  DEFAULT_PREFS,
  dayStats,
  focusLabel,
  formatCountdown,
  nextPhase,
  normalizePrefs,
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

// ---------- 相位推进 ----------
const P = DEFAULT_PREFS // focus 25 / short 5 / long 15 / 每 4 轮
check('休息完回到专注', eq(nextPhase('break', 3, P), { kind: 'focus', minutes: 25, long: false }))
check('第 1 轮专注后是短休息', eq(nextPhase('focus', 1, P), { kind: 'break', minutes: 5, long: false }))
check('第 3 轮后仍是短休息', nextPhase('focus', 3, P).long === false)
check('第 4 轮后是长休息', eq(nextPhase('focus', 4, P), { kind: 'break', minutes: 15, long: true }))
check('第 8 轮后又是长休息', nextPhase('focus', 8, P).long === true)
check('第 5 轮后回到短休息', nextPhase('focus', 5, P).long === false)
check('轮数为 0 时不给长休息', nextPhase('focus', 0, P).long === false)

// ---------- 倒计时 ----------
check('分秒', formatCountdown(90) === '01:30')
check('补零', formatCountdown(5) === '00:05')
check('零', formatCountdown(0) === '00:00')
check('负数夹到零', formatCountdown(-10) === '00:00')
check('超过一小时带时位', formatCountdown(3725) === '1:02:05')

// wall clock：休眠/后台节流之后还得准，所以按 startAt + minutes 反算
const start = '2026-08-28T10:00:00'
const base = new Date(start).getTime()
check('刚开始时剩满', remainingSeconds(start, 25, base) === 1500)
check('过了 10 分钟', remainingSeconds(start, 25, base + 600_000) === 900)
check('走完归零', remainingSeconds(start, 25, base + 1_500_000) === 0)
check('超时也不给负数（合盖两小时再打开）', remainingSeconds(start, 25, base + 7_200_000) === 0)
check('非法起始时刻返回 0', remainingSeconds('不是时刻', 25, base) === 0)

// ---------- 统计 ----------
const s = (o) => ({
  id: 'x',
  startAt: '2026-08-28T10:00:00',
  endAt: '2026-08-28T10:25:00',
  minutes: 25,
  kind: 'focus',
  completed: true,
  blockId: null,
  taskId: null,
  ...o
})
const sessions = [
  s({}),
  s({ startAt: '2026-08-28T11:00:00', minutes: 30 }),
  s({ startAt: '2026-08-28T12:00:00', completed: false }),
  s({ startAt: '2026-08-28T13:00:00', kind: 'break', minutes: 5 }),
  s({ startAt: '2026-08-27T10:00:00' })
]
const today = dayStats(sessions, '2026-08-28')
check('只数完成的专注轮', today.rounds === 2)
check('休息不计入专注时长', today.focusMinutes === 55)
check('中途放弃单独计数', today.abandoned === 1)
check('别的日期不混入', dayStats(sessions, '2026-08-27').rounds === 1)
check('没有记录的日期全零', eq(dayStats(sessions, '2026-08-01'), { rounds: 0, focusMinutes: 0, abandoned: 0 }))
check('非法 startAt 被跳过', dayStats([s({ startAt: '坏数据' })], '2026-08-28').rounds === 0)

check('时长人话：时+分', focusLabel(125) === '2 小时 5 分钟')
check('时长人话：整小时', focusLabel(120) === '2 小时')
check('时长人话：不足一小时', focusLabel(45) === '45 分钟')
check('零说「还没开始」', focusLabel(0) === '还没开始')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
