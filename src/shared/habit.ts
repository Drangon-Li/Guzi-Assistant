// 打卡插件的纯逻辑：连续天数、最近窗口、习惯视图组装。
//
// 口径移植自 macmini 上的 health-tracker，但**日界改成自然日零点**，跟随核心的 dayKey。
// 原版用凌晨 4 点做业务日界，照搬会让打卡的连续天数和日报、活动历史对不上——
// 全站一个口径比单个插件的体感更重要。
//
// 保留原版最好的那条决定：**今天还没打不算断**。今天有记录就从今天数，没有就从昨天
// 往回数——晚上八点打开应用看到「连续 12 天」而不是「连续 0 天」，才不会劝退。
// 同理，断签不清零任何累计值。

export interface Habit {
  id: string
  name: string
  /** 归档是软删：习惯从列表消失，历史打卡保留 */
  archivedAt: string | null
  createdAt: string
}

export interface HabitCheck {
  habitId: string
  /** YYYY-MM-DD */
  date: string
}

export interface HabitView {
  id: string
  name: string
  checkedToday: boolean
  /** 当前连续天数（今天没打不算断） */
  streak: number
  /** 历史最长连续 */
  bestStreak: number
  /** 累计打卡次数 */
  total: number
  /** 最近 N 天是否打卡，下标 0 是最早的一天 */
  recent: boolean[]
}

/** YYYY-MM-DD 平移 delta 天。用正午构造，避开夏令时导致的跨日偏移。 */
export function shiftDate(date: string, delta: number): string {
  const d = new Date(`${date}T12:00:00`)
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() + delta)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 当前连续天数：今天有就从今天数，没有就从昨天往回数。 */
export function streakOf(dates: ReadonlySet<string>, today: string): number {
  let n = 0
  for (let i = dates.has(today) ? 0 : 1; ; i++) {
    if (!dates.has(shiftDate(today, -i))) return n
    n++
  }
}

/** 历史最长连续天数。 */
export function bestStreakOf(dates: ReadonlySet<string>): number {
  const sorted = [...dates].sort()
  let best = 0
  let run = 0
  let prev: string | null = null
  for (const d of sorted) {
    run = prev && shiftDate(prev, 1) === d ? run + 1 : 1
    if (run > best) best = run
    prev = d
  }
  return best
}

/** 最近 days 天的打卡情况，下标 0 是最早的一天，最后一个是 today。 */
export function recentWindow(dates: ReadonlySet<string>, today: string, days = 28): boolean[] {
  const out: boolean[] = []
  for (let i = days - 1; i >= 0; i--) out.push(dates.has(shiftDate(today, -i)))
  return out
}

/** 组装列表页要的全部字段。已归档的习惯不出现在结果里。 */
export function buildHabitViews(
  habits: readonly Habit[],
  checks: readonly HabitCheck[],
  today: string,
  windowDays = 28
): HabitView[] {
  const byHabit = new Map<string, Set<string>>()
  for (const c of checks) {
    let set = byHabit.get(c.habitId)
    if (!set) byHabit.set(c.habitId, (set = new Set()))
    set.add(c.date)
  }
  return habits
    .filter((h) => !h.archivedAt)
    .map((h) => {
      const dates = byHabit.get(h.id) ?? new Set<string>()
      return {
        id: h.id,
        name: h.name,
        checkedToday: dates.has(today),
        streak: streakOf(dates, today),
        bestStreak: bestStreakOf(dates),
        total: dates.size,
        recent: recentWindow(dates, today, windowDays)
      }
    })
}

/** 今天打过卡的习惯数 / 活跃习惯总数——今日页卡片和成就计数都用它。 */
export function todayProgress(views: readonly HabitView[]): { done: number; total: number } {
  return { done: views.filter((v) => v.checkedToday).length, total: views.length }
}
