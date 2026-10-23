// 专注插件的纯逻辑：番茄钟的相位推进、暂停计时与时长统计。
//
// 计时全部按 wall clock 算（记下 startAt 与累计暂停毫秒，每次重算剩余），不做倒数累减——
// 系统休眠、窗口后台节流都会让累减的计时器越走越慢，而 wall clock 不会。
// 暂停同理：不停秒表，只记「从什么时候开始暂停的」，恢复时把这段时长累加进 pausedMs。

export type PomodoroKind = 'focus' | 'break'

export interface PomodoroSession {
  id: string
  /** ISO 时刻 */
  startAt: string
  endAt: string | null
  /** 计划时长，分钟 */
  minutes: number
  kind: PomodoroKind
  /** 提前结束为 false；统计只认 completed 的专注轮 */
  completed: boolean
  /** 累计已暂停的毫秒数（不含当前这次暂停） */
  pausedMs: number
  /** 当前正处于暂停中的起始时刻；null 表示在跑 */
  pausedAt: string | null
  /** 关联的作息时间块（装了「作息」才有） */
  blockId: string | null
  /** 关联的任务 id（来自核心的日程） */
  taskId: string | null
  /** 关联任务的标题快照——任务被删了这轮记录也还看得懂 */
  taskTitle: string | null
  /** 这一轮做了什么 */
  note: string | null
  /** 用户选择保留的 AI 复盘；丢弃或没生成为 null */
  review: string | null
}

/** 每日目标可以按轮数，也可以按时长——「今天专注两小时」和「今天做四轮」是两种人。 */
export type GoalKind = 'rounds' | 'minutes'

export interface DailyGoal {
  kind: GoalKind
  /** kind=rounds 时是轮数，kind=minutes 时是分钟数 */
  value: number
}

export const DEFAULT_GOAL: DailyGoal = { kind: 'rounds', value: 8 }

export const GOAL_LIMITS: Record<GoalKind, { min: number; max: number }> = {
  rounds: { min: 1, max: 30 },
  minutes: { min: 10, max: 960 }
}

export interface PomodoroPrefs {
  focusMin: number
  shortBreakMin: number
  longBreakMin: number
  /** 每几轮专注后给一次长休息 */
  roundsBeforeLongBreak: number
  /** 每日目标：按轮数或按时长 */
  dailyGoal: DailyGoal
  /** 一轮结束后自动开始下一轮 */
  autoStart: boolean
}

export const DEFAULT_PREFS: PomodoroPrefs = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsBeforeLongBreak: 4,
  dailyGoal: DEFAULT_GOAL,
  autoStart: false
}

/**
 * 目标归一。老版本存的是一个裸数字（轮数），这里兼容读进来——
 * 用户改过目标的话不该因为一次升级被悄悄重置。
 */
export function normalizeGoal(raw: unknown): DailyGoal {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const v = Math.round(raw)
    const { min, max } = GOAL_LIMITS.rounds
    return { kind: 'rounds', value: v >= min && v <= max ? v : DEFAULT_GOAL.value }
  }
  if (raw && typeof raw === 'object') {
    const g = raw as Partial<DailyGoal>
    const kind: GoalKind = g.kind === 'minutes' ? 'minutes' : 'rounds'
    const { min, max } = GOAL_LIMITS[kind]
    const v = Math.round(Number(g.value))
    if (Number.isFinite(v) && v >= min && v <= max) return { kind, value: v }
    return { kind, value: kind === 'minutes' ? 120 : DEFAULT_GOAL.value }
  }
  return DEFAULT_GOAL
}

/** 目标的人话：「8 轮」/「2 小时」。 */
export function goalLabel(goal: DailyGoal): string {
  return goal.kind === 'rounds' ? `${goal.value} 轮` : focusLabel(goal.value)
}

/** 当天已完成的量在目标口径下是多少（轮数或分钟）。 */
export function goalCurrentOf(goal: DailyGoal, rounds: number, focusMinutes: number): number {
  return goal.kind === 'rounds' ? rounds : focusMinutes
}

export function normalizePrefs(patch: Partial<PomodoroPrefs>): PomodoroPrefs {
  const clamp = (n: number | undefined, lo: number, hi: number, fallback: number): number => {
    const v = Math.round(Number(n))
    return Number.isFinite(v) && v >= lo && v <= hi ? v : fallback
  }
  return {
    focusMin: clamp(patch.focusMin, 1, 180, DEFAULT_PREFS.focusMin),
    shortBreakMin: clamp(patch.shortBreakMin, 1, 60, DEFAULT_PREFS.shortBreakMin),
    longBreakMin: clamp(patch.longBreakMin, 1, 60, DEFAULT_PREFS.longBreakMin),
    roundsBeforeLongBreak: clamp(patch.roundsBeforeLongBreak, 2, 12, DEFAULT_PREFS.roundsBeforeLongBreak),
    dailyGoal: normalizeGoal(patch.dailyGoal),
    autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : DEFAULT_PREFS.autoStart
  }
}

/** 刚结束一轮之后该进入什么相位。completedFocusToday 是今天已完成的专注轮数（含刚结束的这轮）。 */
export function nextPhase(
  justFinished: PomodoroKind,
  completedFocusToday: number,
  prefs: PomodoroPrefs
): { kind: PomodoroKind; minutes: number; long: boolean } {
  if (justFinished === 'break') return { kind: 'focus', minutes: prefs.focusMin, long: false }
  const long = completedFocusToday > 0 && completedFocusToday % prefs.roundsBeforeLongBreak === 0
  return {
    kind: 'break',
    minutes: long ? prefs.longBreakMin : prefs.shortBreakMin,
    long
  }
}

export type PomodoroPhase = ReturnType<typeof nextPhase>

export interface PomodoroRuntime {
  running: PomodoroSession | null
  next: PomodoroPhase | null
}

/** 剩余秒数 → MM:SS；超过一小时用 H:MM:SS。 */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** 计时所需的最小字段——统计和恢复都只依赖这几项。 */
export interface TimerState {
  startAt: string
  minutes: number
  pausedMs: number
  pausedAt: string | null
}

/**
 * 按 wall clock 算剩余秒数。暂停中时以「进入暂停的那一刻」为参照，
 * 所以暂停期间读数是冻住的，而不是继续往下走。
 */
export function remainingSeconds(s: TimerState, now: number): number {
  const start = new Date(s.startAt).getTime()
  if (Number.isNaN(start)) return 0
  const reference = s.pausedAt ? new Date(s.pausedAt).getTime() : now
  if (Number.isNaN(reference)) return 0
  const elapsed = reference - start - Math.max(0, s.pausedMs)
  return Math.max(0, Math.round((s.minutes * 60_000 - elapsed) / 1000))
}

/** 恢复时该累加多少暂停毫秒。 */
export function pausedMsAfterResume(s: TimerState, now: number): number {
  if (!s.pausedAt) return s.pausedMs
  const at = new Date(s.pausedAt).getTime()
  if (Number.isNaN(at)) return s.pausedMs
  return Math.max(0, s.pausedMs) + Math.max(0, now - at)
}

/** 这一轮实际投入的分钟数（扣掉暂停）。中途放弃的轮次用它统计「真的坐了多久」。 */
export function actualMinutes(s: TimerState, endedAt: number): number {
  const start = new Date(s.startAt).getTime()
  if (Number.isNaN(start)) return 0
  const paused = pausedMsAfterResume(s, endedAt)
  return Math.max(0, Math.round((endedAt - start - paused) / 60_000))
}

export interface DayStats {
  /** 完成的专注轮数 */
  rounds: number
  /** 完成的专注分钟数 */
  focusMinutes: number
  /** 中途放弃的轮数 */
  abandoned: number
  /** 生效的目标（口径 + 数值），界面据此决定显示「轮」还是时长 */
  goal: DailyGoal
  /** 目标口径下今天已完成的量 */
  goalCurrent: number
  /** 距离目标还差多少（口径同上，已达成为 0） */
  remainingToGoal: number
  /** 目标完成比例 0..1 */
  goalProgress: number
}

const dateOf = (iso: string): string | null => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const isAbandoned = (session: PomodoroSession): boolean => !!session.endAt && !session.completed

/** 某一天的专注统计。date 是 YYYY-MM-DD，按 startAt 的本地日期归属。 */
export function dayStats(
  sessions: readonly PomodoroSession[],
  date: string,
  dailyGoal: DailyGoal = DEFAULT_GOAL
): DayStats {
  const goal = normalizeGoal(dailyGoal)
  const focus = sessions.filter((s) => s.kind === 'focus' && dateOf(s.startAt) === date)
  const done = focus.filter((s) => s.completed)
  const rounds = done.length
  const focusMinutes = done.reduce((sum, s) => sum + s.minutes, 0)
  const current = goalCurrentOf(goal, rounds, focusMinutes)
  return {
    rounds,
    focusMinutes,
    abandoned: focus.filter(isAbandoned).length,
    goal,
    goalCurrent: current,
    remainingToGoal: Math.max(0, goal.value - current),
    goalProgress: goal.value > 0 ? Math.min(1, current / goal.value) : 0
  }
}

export interface TaskBreakdown {
  key: string
  label: string
  rounds: number
  minutes: number
}

/**
 * 按关联任务聚合某一天的专注时长——「时间都花在哪儿了」。
 * 没关联任务的归到「未关联」，不丢数据。
 */
export function breakdownByTask(sessions: readonly PomodoroSession[], date: string): TaskBreakdown[] {
  const map = new Map<string, TaskBreakdown>()
  for (const s of sessions) {
    if (s.kind !== 'focus' || !s.completed || dateOf(s.startAt) !== date) continue
    const key = s.taskId ?? '__none__'
    const label = s.taskTitle ?? '未关联任务'
    const row = map.get(key) ?? { key, label, rounds: 0, minutes: 0 }
    row.rounds++
    row.minutes += s.minutes
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes)
}

// ---------- 区间统计 ----------

export type StatsRange = 'week' | 'month' | 'year'

export const RANGE_DAYS: Record<StatsRange, number> = { week: 7, month: 30, year: 365 }

export interface RangeStats {
  /** 完成的专注轮数 */
  rounds: number
  /** 完成的专注分钟数 */
  focusMinutes: number
  /** 中途放弃轮数 */
  abandoned: number
  /** 有过专注的天数 */
  activeDays: number
  /** 达到每日目标的天数 */
  goalDays: number
  /** 有专注的那些天的日均分钟数（不把没开机的日子摊进去，否则数字会假性变低） */
  avgMinutesPerActiveDay: number
  /** 单日最长 */
  bestDay: { date: string; minutes: number; rounds: number } | null
  /** 完成率：完成 /（完成 + 放弃） */
  completionRate: number
  /** 最长连续达标天数 */
  bestGoalStreak: number
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const dateOfIso = (iso: string): string | null => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const hourOfIso = (iso: string): number | null => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.getHours()
}

/** 只保留落在 [fromDate, toDate] 的专注会话（含休息则由调用方先过滤）。 */
function inRange(sessions: readonly PomodoroSession[], fromDate: string, toDate: string): PomodoroSession[] {
  return sessions.filter((s) => {
    const d = dateOfIso(s.startAt)
    return d !== null && d >= fromDate && d <= toDate
  })
}

export function rangeStats(
  sessions: readonly PomodoroSession[],
  fromDate: string,
  toDate: string,
  dailyGoal: DailyGoal = DEFAULT_GOAL
): RangeStats {
  const goal = normalizeGoal(dailyGoal)
  const focus = inRange(sessions, fromDate, toDate).filter((s) => s.kind === 'focus')
  const done = focus.filter((s) => s.completed)
  const abandoned = focus.filter(isAbandoned).length
  const settled = done.length + abandoned

  const byDay = new Map<string, { minutes: number; rounds: number }>()
  for (const s of done) {
    const d = dateOfIso(s.startAt)
    if (!d) continue
    const row = byDay.get(d) ?? { minutes: 0, rounds: 0 }
    row.minutes += s.minutes
    row.rounds++
    byDay.set(d, row)
  }

  const focusMinutes = done.reduce((n, s) => n + s.minutes, 0)
  const activeDays = byDay.size
  const goalDates = [...byDay.entries()]
    .filter(([, v]) => goalCurrentOf(goal, v.rounds, v.minutes) >= goal.value)
    .map(([d]) => d)

  let bestDay: RangeStats['bestDay'] = null
  for (const [date, v] of byDay) {
    if (!bestDay || v.minutes > bestDay.minutes) bestDay = { date, minutes: v.minutes, rounds: v.rounds }
  }

  return {
    rounds: done.length,
    focusMinutes,
    abandoned,
    activeDays,
    goalDays: goalDates.length,
    avgMinutesPerActiveDay: activeDays ? Math.round(focusMinutes / activeDays) : 0,
    bestDay,
    completionRate: settled ? done.length / settled : 0,
    bestGoalStreak: longestConsecutive(goalDates)
  }
}

/** 一组日期里最长的连续段长度。 */
export function longestConsecutive(dates: readonly string[]): number {
  const sorted = [...new Set(dates)].sort()
  let best = 0
  let run = 0
  let prev: string | null = null
  for (const d of sorted) {
    if (prev && shiftDay(prev, 1) === d) run++
    else run = 1
    if (run > best) best = run
    prev = d
  }
  return best
}

function shiftDay(date: string, delta: number): string {
  const d = new Date(`${date}T12:00:00`)
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() + delta)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 一天 24 小时里各时段完成的专注分钟数——「你几点最专注」。 */
export function byHour(sessions: readonly PomodoroSession[], fromDate: string, toDate: string): number[] {
  const out = Array<number>(24).fill(0)
  for (const s of inRange(sessions, fromDate, toDate)) {
    if (s.kind !== 'focus' || !s.completed) continue
    const h = hourOfIso(s.startAt)
    if (h !== null) out[h] += s.minutes
  }
  return out
}

/** 周日..周六各自完成的专注分钟数。 */
export function byWeekday(sessions: readonly PomodoroSession[], fromDate: string, toDate: string): number[] {
  const out = Array<number>(7).fill(0)
  for (const s of inRange(sessions, fromDate, toDate)) {
    if (s.kind !== 'focus' || !s.completed) continue
    const d = new Date(s.startAt)
    if (!Number.isNaN(d.getTime())) out[d.getDay()] += s.minutes
  }
  return out
}

/** 区间内按关联任务聚合，用于「这个月时间都花在哪」。 */
export function rangeByTask(
  sessions: readonly PomodoroSession[],
  fromDate: string,
  toDate: string,
  limit = 8
): TaskBreakdown[] {
  const map = new Map<string, TaskBreakdown>()
  for (const s of inRange(sessions, fromDate, toDate)) {
    if (s.kind !== 'focus' || !s.completed) continue
    const key = s.taskId ?? '__none__'
    const label = s.taskTitle ?? '未关联任务'
    const row = map.get(key) ?? { key, label, rounds: 0, minutes: 0 }
    row.rounds++
    row.minutes += s.minutes
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes).slice(0, limit)
}

/** 「2 小时 5 分钟」；0 分钟说「还没开始」。 */
export function focusLabel(minutes: number): string {
  if (minutes <= 0) return '还没开始'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}
