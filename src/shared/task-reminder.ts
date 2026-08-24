// 任务提醒判定纯函数：算出「此刻该提醒哪些任务」。注入 now，便于单测与主进程调度复用。
// 事件时刻取 startTime ?? dueTime（与 daily-brief 的 dueTime 优先相反：提醒要赶在「开始」之前）。
import type { Belongs, Priority, TaskStatus } from './types'

/** 仍需处理的状态（pending 还没被用户认下，done/ignored 已了结，都不提醒） */
const ACTIVE_STATUS = new Set<TaskStatus>(['not_started', 'scheduled', 'in_progress', 'overdue'])
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 }
/** 只有日期没有时分的任务，按当天这个钟点提醒 */
const DATE_ONLY_HOUR = 9
/** 事件时刻前后这个范围内算「正点」 */
const ONTIME_TOLERANCE_MS = 60_000
const MAX_OFFSET_MIN = 1440

export interface ReminderTask {
  id: string
  startTime: string | null
  dueTime: string | null
  status: TaskStatus
  belongsToUser: Belongs
  priority: Priority
  /** null = 跟随全局默认；负数 = 该任务关闭提醒 */
  remindOffsetMin: number | null
  /** 已提醒过的目标时刻（本地 ISO），幂等键 */
  remindedAt: string | null
  /** 稍后提醒到的时刻（本地 ISO） */
  snoozedUntil: string | null
}

export interface DueReminder {
  taskId: string
  /** 本次提醒的目标时刻，触发后写回 reminded_at 做幂等 */
  targetIso: string
  /** 事件真正发生的时刻，供卡片文案 */
  eventIso: string
  kind: 'ahead' | 'ontime' | 'catchup' | 'snooze'
}

export interface ReminderOptions {
  enabled: boolean
  defaultOffsetMin: number
  /** 逾期补提醒窗口：超过这个时长没提醒过的就不补了 */
  catchupWindowMin: number
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function localIso(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 本地 ISO（YYYY-MM-DDTHH:mm）→ 毫秒。带时分的形式按本地时区解析，无法解析返回 null。 */
function parseLocal(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** 只有日期的补成当天 DATE_ONLY_HOUR 点（`2026-08-24` 直接 parse 会被当成 UTC 午夜）。 */
function normalizeEventIso(raw: string): string {
  return raw.length === 10 ? `${raw}T${pad(DATE_ONLY_HOUR)}:00` : raw
}

function eventIsoOf(task: ReminderTask): string | null {
  const raw = task.startTime ?? task.dueTime
  return raw ? normalizeEventIso(raw) : null
}

function clampOffset(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0
  return Math.min(MAX_OFFSET_MIN, Math.max(0, Math.round(minutes)))
}

/** 人类可读的时长（提醒文案用，不追求精确到分秒）。 */
function humanGap(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} 分钟`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

/** 提醒卡与系统通知共用的时间文案。主进程和渲染层都调它，口径只有一处。 */
export function reminderWhenLabel(
  item: { eventIso: string; kind: DueReminder['kind'] },
  now: Date
): string {
  const eventIso = normalizeEventIso(item.eventIso)
  const hhmm = eventIso.length >= 16 ? eventIso.slice(11, 16) : ''
  const eventMs = parseLocal(eventIso)
  if (item.kind === 'snooze') return hhmm ? `稍后提醒 · 原定 ${hhmm}` : '稍后提醒'
  if (eventMs === null) return hhmm
  const diff = eventMs - now.getTime()
  if (item.kind === 'catchup' || diff < -ONTIME_TOLERANCE_MS) return `已逾期 ${humanGap(-diff)}`
  if (item.kind === 'ontime' || Math.abs(diff) <= ONTIME_TOLERANCE_MS) return hhmm ? `现在 · ${hhmm}` : '现在'
  return hhmm ? `${humanGap(diff)}后 · ${hhmm}` : `${humanGap(diff)}后`
}

export function dueReminders(
  tasks: readonly ReminderTask[],
  opts: ReminderOptions,
  now: Date
): DueReminder[] {
  if (!opts.enabled) return []
  const nowMs = now.getTime()
  const catchupMs = Math.max(0, opts.catchupWindowMin) * 60_000
  const hits: (DueReminder & { eventMs: number; rank: number })[] = []

  for (const task of tasks) {
    if (task.belongsToUser !== 'yes') continue
    if (!ACTIVE_STATUS.has(task.status)) continue
    if (task.remindOffsetMin != null && task.remindOffsetMin < 0) continue
    const eventIso = eventIsoOf(task)
    if (!eventIso) continue
    const eventMs = parseLocal(eventIso)
    if (eventMs === null) continue

    let targetIso: string
    let kind: DueReminder['kind']
    if (task.snoozedUntil) {
      // 稍后提醒的幂等键是 snoozedUntil 本身。改任务时间时由 updateTask 清空
      // reminded_at/snoozed_until 复位——否则旧的稍后会让新时刻永远提醒不出来。
      if (task.remindedAt === task.snoozedUntil) continue
      const snoozeMs = parseLocal(task.snoozedUntil)
      if (snoozeMs === null || snoozeMs > nowMs) continue
      targetIso = task.snoozedUntil
      kind = 'snooze' // 用户自己按的稍后，必须兑现，不受 catchup 窗口限制
    } else {
      const targetMs = eventMs - clampOffset(task.remindOffsetMin ?? opts.defaultOffsetMin) * 60_000
      if (targetMs > nowMs) continue
      if (nowMs - targetMs > catchupMs) continue
      targetIso = localIso(targetMs)
      if (task.remindedAt === targetIso) continue
      kind =
        nowMs < eventMs - ONTIME_TOLERANCE_MS
          ? 'ahead'
          : nowMs <= eventMs + ONTIME_TOLERANCE_MS
            ? 'ontime'
            : 'catchup'
    }

    hits.push({
      taskId: task.id,
      targetIso,
      eventIso,
      kind,
      eventMs,
      rank: PRIORITY_RANK[task.priority] ?? 3
    })
  }

  hits.sort((a, b) => (a.eventMs !== b.eventMs ? a.eventMs - b.eventMs : a.rank - b.rank))
  return hits.map(({ taskId, targetIso, eventIso, kind }) => ({ taskId, targetIso, eventIso, kind }))
}
