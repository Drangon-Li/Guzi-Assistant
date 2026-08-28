// 打卡插件的纯逻辑：频率、连续天数、跳过日、完成率与热力图窗口。
//
// 口径移植自 macmini 上的 health-tracker，但**日界改成自然日零点**，跟随核心的 dayKey。
// 原版用凌晨 4 点做业务日界，照搬会让打卡的连续天数和日报、活动历史对不上——
// 全站一个口径比单个插件的体感更重要。
//
// 保留原版最好的那条决定：**今天还没打不算断**。今天有记录就从今天数，没有就从昨天
// 往回数——晚上八点打开应用看到「连续 12 天」而不是「连续 0 天」，才不会劝退。
// 同理，断签不清零任何累计值。
//
// 在此之上补了竞品（Loop / Streaks / TickTick）都有、原版没有的两件事：
//  - **频率**：不是每个习惯都该每天做。只在「该做的日子」判断连续，周末不做不算断。
//  - **跳过日**：生病、出差主动标记跳过，连续不断——Duolingo 的 streak freeze 同理，
//    它挡住的是「反正断了，不如放弃」这个真正的流失点。

export type HabitFrequency =
  | { kind: 'daily' }
  /** 指定星期几；0=周日 … 6=周六 */
  | { kind: 'weekdays'; days: number[] }
  /** 每周任意 N 天 */
  | { kind: 'weekly'; times: number }

export interface Habit {
  id: string
  name: string
  frequency: HabitFrequency
  /** 归档是软删：习惯从列表消失，历史打卡保留 */
  archivedAt: string | null
  createdAt: string
}

export interface HabitCheck {
  habitId: string
  /** YYYY-MM-DD */
  date: string
  /** true 表示主动跳过（不算完成，但不断签） */
  skipped: boolean
  note: string | null
}

export type DayState = 'done' | 'skipped' | 'missed' | 'off'

export interface HabitView {
  id: string
  name: string
  frequency: HabitFrequency
  frequencyLabel: string
  checkedToday: boolean
  skippedToday: boolean
  /** 今天是否属于「该做的日子」 */
  dueToday: boolean
  /** 当前连续（今天没打不算断；跳过日不断） */
  streak: number
  /** 历史最长连续 */
  bestStreak: number
  /** 累计完成次数（不含跳过） */
  total: number
  /** 最近 N 天每天的状态，下标 0 最早 */
  recent: DayState[]
  /** 最近 N 天的完成率：完成 / 该做（跳过日不计入分母） */
  rate: number
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const pad = (n: number): string => String(n).padStart(2, '0')

/** YYYY-MM-DD 平移 delta 天。用正午构造，避开夏令时导致的跨日偏移。 */
export function shiftDate(date: string, delta: number): string {
  const d = new Date(`${date}T12:00:00`)
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() + delta)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function weekdayOf(date: string): number {
  const d = new Date(`${date}T12:00:00`)
  return Number.isNaN(d.getTime()) ? 0 : d.getDay()
}

/** 这一天该不该做。weekly 频率没有「哪天该做」的概念，任何一天都算数。 */
export function isDue(freq: HabitFrequency, date: string): boolean {
  if (freq.kind === 'daily') return true
  if (freq.kind === 'weekly') return true
  return freq.days.includes(weekdayOf(date))
}

export function frequencyLabel(freq: HabitFrequency): string {
  if (freq.kind === 'daily') return '每天'
  if (freq.kind === 'weekly') return `每周 ${freq.times} 次`
  const days = [...new Set(freq.days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
  if (!days.length) return '未设定'
  if (days.length === 7) return '每天'
  const isRun = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  if (isRun && days.length > 2)
    return `周${WEEKDAY_LABELS[days[0]]}至周${WEEKDAY_LABELS[days[days.length - 1]]}`
  return days.map((d) => `周${WEEKDAY_LABELS[d]}`).join('、')
}

export function normalizeFrequency(raw: unknown): HabitFrequency {
  if (raw && typeof raw === 'object') {
    const f = raw as Partial<HabitFrequency> & { days?: unknown; times?: unknown }
    if (f.kind === 'weekdays' && Array.isArray(f.days)) {
      const days = f.days.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
      if (days.length) return { kind: 'weekdays', days: [...new Set(days)].sort((a, b) => a - b) }
    }
    if (f.kind === 'weekly') {
      const times = Math.round(Number(f.times))
      if (Number.isFinite(times) && times >= 1 && times <= 7) return { kind: 'weekly', times }
    }
  }
  return { kind: 'daily' }
}

/** 该日期所在周的周一。 */
export function mondayOf(date: string): string {
  const wd = weekdayOf(date)
  return shiftDate(date, wd === 0 ? -6 : 1 - wd)
}

interface Marks {
  done: ReadonlySet<string>
  skipped: ReadonlySet<string>
}

/**
 * 当前连续：今天有就从今天数，没有就从昨天往回数。
 * 不该做的日子直接跳过（不加也不断），主动跳过的日子接上但不计数。
 * weekly 频率按「周」数：某周达标次数够了就算一周。
 */
export function streakOf(marks: Marks, freq: HabitFrequency, today: string): number {
  if (freq.kind === 'weekly') return weeklyStreak(marks, freq.times, today)

  let n = 0
  let cursor = today
  // 今天还没做不算断——从今天往回，第一格允许缺
  if (!marks.done.has(today) && !marks.skipped.has(today)) cursor = shiftDate(today, -1)

  for (let guard = 0; guard < 3650; guard++) {
    if (!isDue(freq, cursor)) {
      cursor = shiftDate(cursor, -1)
      continue
    }
    if (marks.done.has(cursor)) n++
    else if (!marks.skipped.has(cursor)) break
    cursor = shiftDate(cursor, -1)
  }
  return n
}

function weeklyStreak(marks: Marks, times: number, today: string): number {
  let n = 0
  let week = mondayOf(today)
  const countIn = (monday: string): number => {
    let c = 0
    for (let i = 0; i < 7; i++) if (marks.done.has(shiftDate(monday, i))) c++
    return c
  }
  // 本周还没攒够不算断——本周不达标就从上周开始数
  if (countIn(week) < times) week = shiftDate(week, -7)
  for (let guard = 0; guard < 520; guard++) {
    if (countIn(week) < times) break
    n++
    week = shiftDate(week, -7)
  }
  return n
}

/** 历史最长连续。逐日回溯，代价与跨度成正比，够用。 */
export function bestStreakOf(marks: Marks, freq: HabitFrequency): number {
  const all = [...marks.done].sort()
  if (!all.length) return 0
  let best = 0
  for (const start of all) {
    const s = streakOf(marks, freq, start)
    if (s > best) best = s
  }
  return best
}

/** 最近 days 天每天的状态，下标 0 是最早的一天，最后一个是 today。 */
export function recentWindow(
  marks: Marks,
  freq: HabitFrequency,
  today: string,
  days = 28
): DayState[] {
  const out: DayState[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDate(today, -i)
    if (marks.done.has(date)) out.push('done')
    else if (marks.skipped.has(date)) out.push('skipped')
    else if (!isDue(freq, date)) out.push('off')
    else if (date === today) out.push('off') // 今天还没到晚上，不算 missed
    else out.push('missed')
  }
  return out
}

/** 完成率：完成 / 该做。跳过日和不该做的日子都不进分母。 */
export function completionRate(window: readonly DayState[]): number {
  const due = window.filter((s) => s === 'done' || s === 'missed').length
  if (!due) return 1
  return window.filter((s) => s === 'done').length / due
}

/** 组装列表页要的全部字段。已归档的习惯不出现在结果里。 */
export function buildHabitViews(
  habits: readonly Habit[],
  checks: readonly HabitCheck[],
  today: string,
  windowDays = 28
): HabitView[] {
  const byHabit = new Map<string, { done: Set<string>; skipped: Set<string> }>()
  for (const c of checks) {
    let m = byHabit.get(c.habitId)
    if (!m) byHabit.set(c.habitId, (m = { done: new Set(), skipped: new Set() }))
    ;(c.skipped ? m.skipped : m.done).add(c.date)
  }

  return habits
    .filter((h) => !h.archivedAt)
    .map((h) => {
      const marks = byHabit.get(h.id) ?? { done: new Set<string>(), skipped: new Set<string>() }
      const recent = recentWindow(marks, h.frequency, today, windowDays)
      return {
        id: h.id,
        name: h.name,
        frequency: h.frequency,
        frequencyLabel: frequencyLabel(h.frequency),
        checkedToday: marks.done.has(today),
        skippedToday: marks.skipped.has(today),
        dueToday: isDue(h.frequency, today),
        streak: streakOf(marks, h.frequency, today),
        bestStreak: bestStreakOf(marks, h.frequency),
        total: marks.done.size,
        recent,
        rate: completionRate(recent)
      }
    })
}

/** 今天该做的里完成了几个——今日页卡片和成就计数都用它。 */
export function todayProgress(views: readonly HabitView[]): { done: number; total: number } {
  const due = views.filter((v) => v.dueToday && !v.skippedToday)
  return { done: due.filter((v) => v.checkedToday).length, total: due.length }
}
