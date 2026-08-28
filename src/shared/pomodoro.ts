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
}

export interface PomodoroPrefs {
  focusMin: number
  shortBreakMin: number
  longBreakMin: number
  /** 每几轮专注后给一次长休息 */
  roundsBeforeLongBreak: number
  /** 每日目标轮数 */
  dailyGoal: number
  /** 一轮结束后自动开始下一轮 */
  autoStart: boolean
}

export const DEFAULT_PREFS: PomodoroPrefs = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsBeforeLongBreak: 4,
  dailyGoal: 8,
  autoStart: false
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
    dailyGoal: clamp(patch.dailyGoal, 1, 30, DEFAULT_PREFS.dailyGoal),
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
  /** 距离每日目标还差几轮（已达成为 0） */
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

/** 某一天的专注统计。date 是 YYYY-MM-DD，按 startAt 的本地日期归属。 */
export function dayStats(
  sessions: readonly PomodoroSession[],
  date: string,
  dailyGoal = DEFAULT_PREFS.dailyGoal
): DayStats {
  const focus = sessions.filter((s) => s.kind === 'focus' && dateOf(s.startAt) === date)
  const done = focus.filter((s) => s.completed)
  const rounds = done.length
  return {
    rounds,
    focusMinutes: done.reduce((sum, s) => sum + s.minutes, 0),
    abandoned: focus.length - done.length,
    remainingToGoal: Math.max(0, dailyGoal - rounds),
    goalProgress: dailyGoal > 0 ? Math.min(1, rounds / dailyGoal) : 0
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

/** 「2 小时 5 分钟」；0 分钟说「还没开始」。 */
export function focusLabel(minutes: number): string {
  if (minutes <= 0) return '还没开始'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}
