// 纯函数单测：打卡插件的连续天数与视图组装。运行：npm run test habit
//
// 重点卡住那条从 health-tracker 移植过来的口径：**今天还没打不算断**。
// 这条一旦被改成「今天没打就归零」，晚上打开应用会看到连续 0 天，是最容易劝退的设计。
import {
  bestStreakOf,
  buildHabitViews,
  recentWindow,
  shiftDate,
  streakOf,
  todayProgress
} from '../src/shared/habit.ts'

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const set = (...d) => new Set(d)

// ---------- 日期平移 ----------
check('往前一天', shiftDate('2026-08-28', -1) === '2026-08-27')
check('往后一天', shiftDate('2026-08-28', 1) === '2026-08-29')
check('跨月', shiftDate('2026-09-01', -1) === '2026-08-31')
check('跨年', shiftDate('2026-01-01', -1) === '2025-12-31')
check('闰年 2 月', shiftDate('2024-03-01', -1) === '2024-02-29')
check('非闰年 2 月', shiftDate('2026-03-01', -1) === '2026-02-28')
check('非法日期原样返回', shiftDate('不是日期', -1) === '不是日期')

// ---------- 连续天数 ----------
const T = '2026-08-28'
check('今天打了 → 从今天数', streakOf(set(T, '2026-08-27', '2026-08-26'), T) === 3)
check(
  '今天还没打 → 从昨天数，不算断',
  streakOf(set('2026-08-27', '2026-08-26', '2026-08-25'), T) === 3
)
check('昨天今天都没打 → 0（断在昨天）', streakOf(set('2026-08-26'), T) === 0)
check('只有今天 → 1', streakOf(set(T), T) === 1)
check('全空 → 0', streakOf(set(), T) === 0)
check('中间断了就停', streakOf(set(T, '2026-08-27', '2026-08-25'), T) === 2)
check('跨月连续', streakOf(set('2026-09-01', '2026-08-31', '2026-08-30'), '2026-09-01') === 3)

check('历史最长连续', bestStreakOf(set('2026-08-01', '2026-08-02', '2026-08-03', '2026-08-10')) === 3)
check('最长连续：全不连续 → 1', bestStreakOf(set('2026-08-01', '2026-08-05')) === 1)
check('最长连续：空 → 0', bestStreakOf(set()) === 0)
check('最长连续跨月', bestStreakOf(set('2026-08-31', '2026-09-01', '2026-09-02')) === 3)

// ---------- 最近窗口 ----------
const w = recentWindow(set(T, '2026-08-26'), T, 4)
check('窗口长度正确', w.length === 4)
check('最后一格是今天', w[3] === true)
check('倒数第三格是 08-26', eq(w, [false, true, false, true]))

// ---------- 视图组装 ----------
const habits = [
  { id: 'h1', name: '走 20 分钟', archivedAt: null, createdAt: '2026-08-01T00:00:00' },
  { id: 'h2', name: '读 10 页', archivedAt: null, createdAt: '2026-08-02T00:00:00' },
  { id: 'h3', name: '已归档的', archivedAt: '2026-08-20T00:00:00', createdAt: '2026-08-01T00:00:00' }
]
const checks = [
  { habitId: 'h1', date: T },
  { habitId: 'h1', date: '2026-08-27' },
  { habitId: 'h2', date: '2026-08-26' },
  { habitId: 'h3', date: T }
]
const views = buildHabitViews(habits, checks, T, 7)

check('已归档的不出现在列表里', views.length === 2)
check('归档的历史打卡仍在库里（只是不展示）', checks.some((c) => c.habitId === 'h3'))
check('今日已打卡标记', views[0].checkedToday === true)
check('今日未打卡标记', views[1].checkedToday === false)
check('连续天数', views[0].streak === 2)
check('没打卡的习惯连续为 0（昨天也没打）', views[1].streak === 0)
check('累计次数', views[0].total === 2)
check('窗口长度跟随参数', views[0].recent.length === 7)
check('没有打卡记录的习惯也不报错', buildHabitViews([habits[0]], [], T)[0].total === 0)

check('今日进度', eq(todayProgress(views), { done: 1, total: 2 }))
check('空列表进度', eq(todayProgress([]), { done: 0, total: 0 }))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
