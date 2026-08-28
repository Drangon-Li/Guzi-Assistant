// 专注插件的纯逻辑：番茄钟的相位推进与时长统计。
//
// 计时本身由渲染层按 wall clock 算（记下 startAt，每秒重算剩余），不做倒数累减——
// 系统休眠、窗口后台节流都会让累减的计时器越走越慢，而 wall clock 不会。

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
  /** 关联的作息时间块（装了「作息」才有） */
  blockId: string | null
  taskId: string | null
}

export interface PomodoroPrefs {
  focusMin: number
  shortBreakMin: number
  longBreakMin: number
  /** 每几轮专注后给一次长休息 */
  roundsBeforeLongBreak: number
}

export const DEFAULT_PREFS: PomodoroPrefs = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsBeforeLongBreak: 4
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
    roundsBeforeLongBreak: clamp(patch.roundsBeforeLongBreak, 2, 12, DEFAULT_PREFS.roundsBeforeLongBreak)
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

/** 按 wall clock 算剩余秒数——休眠或后台节流之后依然准。 */
export function remainingSeconds(startAt: string, minutes: number, now: number): number {
  const start = new Date(startAt).getTime()
  if (Number.isNaN(start)) return 0
  return Math.max(0, Math.round((start + minutes * 60_000 - now) / 1000))
}

export interface DayStats {
  /** 完成的专注轮数 */
  rounds: number
  /** 完成的专注分钟数 */
  focusMinutes: number
  /** 中途放弃的轮数 */
  abandoned: number
}

/** 某一天的专注统计。date 是 YYYY-MM-DD，按 startAt 的本地日期归属。 */
export function dayStats(sessions: readonly PomodoroSession[], date: string): DayStats {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const onDate = sessions.filter((s) => {
    const d = new Date(s.startAt)
    if (Number.isNaN(d.getTime())) return false
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === date
  })
  const focus = onDate.filter((s) => s.kind === 'focus')
  const done = focus.filter((s) => s.completed)
  return {
    rounds: done.length,
    focusMinutes: done.reduce((sum, s) => sum + s.minutes, 0),
    abandoned: focus.length - done.length
  }
}

/** 「2 小时 5 分钟」；0 分钟说「还没开始」。 */
export function focusLabel(minutes: number): string {
  if (minutes <= 0) return '还没开始'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}
