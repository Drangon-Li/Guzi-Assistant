// 纯函数单测：打卡插件的频率、连续天数、跳过日与完成率。运行：npm run test habit
//
// 卡住三条口径，它们决定这一页是让人想再来还是想删掉：
//  1. **今天还没打不算断**（移植自 health-tracker）
//  2. **不该做的日子不算断**——周末不做的习惯，周一看到的应该还是连续
//  3. **主动跳过不算断**（Duolingo streak freeze 同理）：挡住「反正断了，不如放弃」
import {
  bestStreakOf,
  buildHabitViews,
  completionRate,
  frequencyLabel,
  isDue,
  mondayOf,
  normalizeFrequency,
  recentWindow,
  shiftDate,
  streakOf,
  todayProgress,
  weekdayOf
} from '../src/shared/habit.ts'

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const marks = (done = [], skipped = []) => ({ done: new Set(done), skipped: new Set(skipped) })

const DAILY = { kind: 'daily' }
const WEEKDAYS = { kind: 'weekdays', days: [1, 2, 3, 4, 5] } // 周一至周五
const WEEKLY3 = { kind: 'weekly', times: 3 }

// ---------- 日期 ----------
check('往前一天', shiftDate('2026-08-28', -1) === '2026-08-27')
check('跨月', shiftDate('2026-09-01', -1) === '2026-08-31')
check('跨年', shiftDate('2026-01-01', -1) === '2025-12-31')
check('闰年 2 月', shiftDate('2024-03-01', -1) === '2024-02-29')
check('非闰年 2 月', shiftDate('2026-03-01', -1) === '2026-02-28')
check('非法日期原样返回', shiftDate('不是日期', -1) === '不是日期')
// 2026-08-28 是周五
check('星期几', weekdayOf('2026-08-28') === 5)
check('周一归位', mondayOf('2026-08-28') === '2026-08-24')
check('周日算上一周的周一', mondayOf('2026-08-30') === '2026-08-24')

// ---------- 频率 ----------
check('每天：任何一天都该做', isDue(DAILY, '2026-08-29'))
check('工作日：周五该做', isDue(WEEKDAYS, '2026-08-28'))
check('工作日：周六不该做', !isDue(WEEKDAYS, '2026-08-29'))
check('每周 N 次：哪天都算数', isDue(WEEKLY3, '2026-08-29'))

check('每天的文案', frequencyLabel(DAILY) === '每天')
check('连续星期用区间', frequencyLabel(WEEKDAYS) === '周一至周五')
check('不连续则列举', frequencyLabel({ kind: 'weekdays', days: [1, 3, 5] }) === '周一、周三、周五')
check('七天等于每天', frequencyLabel({ kind: 'weekdays', days: [0, 1, 2, 3, 4, 5, 6] }) === '每天')
check('每周 N 次的文案', frequencyLabel(WEEKLY3) === '每周 3 次')

check('归一：缺省是每天', eq(normalizeFrequency(undefined), DAILY))
check('归一：坏数据回落每天', eq(normalizeFrequency({ kind: 'weekdays', days: [] }), DAILY))
check('归一：星期去重排序', eq(normalizeFrequency({ kind: 'weekdays', days: [5, 1, 1] }), { kind: 'weekdays', days: [1, 5] }))
check('归一：每周次数越界回落', eq(normalizeFrequency({ kind: 'weekly', times: 99 }), DAILY))

// ---------- 连续（每天） ----------
const T = '2026-08-28'
check('今天打了 → 从今天数', streakOf(marks([T, '2026-08-27', '2026-08-26']), DAILY, T) === 3)
check(
  '今天还没打 → 从昨天数，不算断',
  streakOf(marks(['2026-08-27', '2026-08-26', '2026-08-25']), DAILY, T) === 3
)
check('昨天今天都没打 → 0', streakOf(marks(['2026-08-26']), DAILY, T) === 0)
check('只有今天 → 1', streakOf(marks([T]), DAILY, T) === 1)
check('全空 → 0', streakOf(marks(), DAILY, T) === 0)
check('中间断了就停', streakOf(marks([T, '2026-08-27', '2026-08-25']), DAILY, T) === 2)
check('跨月连续', streakOf(marks(['2026-09-01', '2026-08-31', '2026-08-30']), DAILY, '2026-09-01') === 3)

// ---------- 跳过日 ----------
check(
  '主动跳过接上连续，但不计入次数',
  streakOf(marks([T, '2026-08-26'], ['2026-08-27']), DAILY, T) === 2
)
check(
  '连着跳两天也不断',
  streakOf(marks([T, '2026-08-25'], ['2026-08-27', '2026-08-26']), DAILY, T) === 2
)
check('今天跳过 → 从今天这一段算起，不断', streakOf(marks(['2026-08-27'], [T]), DAILY, T) === 1)

// ---------- 连续（指定星期） ----------
// 2026-08-24(一)…28(五) 工作日，29/30 是周末
check(
  '周末不做不算断：周一看仍是连续 5',
  streakOf(marks(['2026-08-28', '2026-08-27', '2026-08-26', '2026-08-25', '2026-08-24']), WEEKDAYS, '2026-08-31') === 5
)
check(
  '工作日漏了一天就断',
  streakOf(marks(['2026-08-28', '2026-08-27', '2026-08-25']), WEEKDAYS, '2026-08-28') === 2
)
check('周六查询时不因为「周六没打」而断', streakOf(marks(['2026-08-28']), WEEKDAYS, '2026-08-29') === 1)

// ---------- 连续（每周 N 次） ----------
const week = (monday, n) => Array.from({ length: n }, (_, i) => shiftDate(monday, i))
check(
  '本周够 3 次 → 连续 1 周',
  streakOf(marks(week('2026-08-24', 3)), WEEKLY3, '2026-08-28') === 1
)
check(
  '本周不够但上周够 → 不算断，仍是 1',
  streakOf(marks([...week('2026-08-24', 1), ...week('2026-08-17', 3)]), WEEKLY3, '2026-08-28') === 1
)
check(
  '连着两周达标 → 2',
  streakOf(marks([...week('2026-08-24', 3), ...week('2026-08-17', 3)]), WEEKLY3, '2026-08-28') === 2
)
check('从来没达标 → 0', streakOf(marks(week('2026-08-24', 1)), WEEKLY3, '2026-08-28') === 0)

// ---------- 最长连续 ----------
check('历史最长', bestStreakOf(marks(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-10']), DAILY) === 3)
check('全不连续 → 1', bestStreakOf(marks(['2026-08-01', '2026-08-05']), DAILY) === 1)
check('空 → 0', bestStreakOf(marks(), DAILY) === 0)

// ---------- 最近窗口与完成率 ----------
const w = recentWindow(marks([T, '2026-08-26'], ['2026-08-27']), DAILY, T, 4)
check('窗口长度', w.length === 4)
check('状态序列（25 没做 / 26 完成 / 27 跳过 / 28 完成）', eq(w, ['missed', 'done', 'skipped', 'done']))
check('工作日窗口里周末标 off', recentWindow(marks(), WEEKDAYS, '2026-08-31', 3).includes('off'))
check('今天没做不标 missed（还没到晚上）', recentWindow(marks(), DAILY, T, 1)[0] === 'off')

check('完成率：跳过和 off 不进分母', completionRate(['done', 'skipped', 'off', 'missed']) === 0.5)
check('完成率：没有该做的日子按 1 算', completionRate(['skipped', 'off']) === 1)
check('完成率：全做到 → 1', completionRate(['done', 'done']) === 1)

// ---------- 视图组装 ----------
const habits = [
  { id: 'h1', name: '走 20 分钟', frequency: DAILY, archivedAt: null, createdAt: '2026-08-01T00:00:00' },
  { id: 'h2', name: '读 10 页', frequency: WEEKDAYS, archivedAt: null, createdAt: '2026-08-02T00:00:00' },
  { id: 'h3', name: '已归档的', frequency: DAILY, archivedAt: '2026-08-20T00:00:00', createdAt: '2026-08-01T00:00:00' }
]
const checks = [
  { habitId: 'h1', date: T, skipped: false, note: '绕了公园一圈' },
  { habitId: 'h1', date: '2026-08-27', skipped: false, note: null },
  { habitId: 'h2', date: '2026-08-26', skipped: false, note: null },
  { habitId: 'h3', date: T, skipped: false, note: null }
]
const views = buildHabitViews(habits, checks, T, 7)

check('已归档的不出现在列表里', views.length === 2)
check('归档的历史打卡仍在库里（只是不展示）', checks.some((c) => c.habitId === 'h3'))
check('今日已打卡标记', views[0].checkedToday === true)
check('今日未打卡标记', views[1].checkedToday === false)
check('频率文案带出来', views[1].frequencyLabel === '周一至周五')
check('今天该不该做', views[1].dueToday === true) // 08-28 周五
check('连续天数', views[0].streak === 2)
check('累计次数', views[0].total === 2)
check('窗口长度跟随参数', views[0].recent.length === 7)
check('完成率算出来了', typeof views[0].rate === 'number')
check('没有打卡记录的习惯也不报错', buildHabitViews([habits[0]], [], T)[0].total === 0)

check('今日进度只数该做的', eq(todayProgress(views), { done: 1, total: 2 }))
check('空列表进度', eq(todayProgress([]), { done: 0, total: 0 }))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
