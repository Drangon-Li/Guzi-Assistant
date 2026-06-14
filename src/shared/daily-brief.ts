// 每日简报纯函数：从任务里挑出「今天属于你的、待办的事」，生成一句聚焦提示。
// 纯函数 + 注入 now，便于单测与主进程通知复用。选取/排序规则为合理默认，可按产品意图调整。
import type { TaskRecord } from './types'

/** 仍需处理的状态（已完成/已忽略/待确认不计入「今天要做的事」） */
const ACTIVE_STATUS = new Set(['not_started', 'scheduled', 'in_progress', 'overdue'])
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 }

export interface DailyBrief {
  /** 今天待办的「你的事」数量 */
  count: number
  /** 最紧急一项的任务 id（无则 null） */
  topTaskId: string | null
  /** 一句话简报文案 */
  message: string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const dayKeyOf = (iso: string): string => iso.slice(0, 10)
const hhmmOf = (iso: string): string => (iso.length >= 16 ? iso.slice(11, 16) : '')

/**
 * tasks：全部任务；now：当前时间（注入以便测试）。
 * 「今天的事」= 属于本人、仍待办、且截止/开始时间在今天或更早（含逾期）。
 * 紧急度：时间早者优先（逾期自然最早），同时间按优先级。
 */
export function buildDailyBrief(tasks: TaskRecord[], now: Date): DailyBrief {
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

  const relevant = tasks
    .filter((t) => t.belongsToUser === 'yes' && ACTIVE_STATUS.has(t.status))
    .map((t) => ({ t, time: t.dueTime ?? t.startTime }))
    .filter((x): x is { t: TaskRecord; time: string } => !!x.time && dayKeyOf(x.time) <= todayKey)

  relevant.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1
    return (PRIORITY_RANK[a.t.priority] ?? 3) - (PRIORITY_RANK[b.t.priority] ?? 3)
  })

  const count = relevant.length
  if (count === 0) {
    return { count: 0, topTaskId: null, message: '今天没有待办的安排，安心过这一天。' }
  }

  const top = relevant[0]
  const overdue = dayKeyOf(top.time) < todayKey || top.t.status === 'overdue'
  const when = overdue ? '已逾期' : hhmmOf(top.time) ? `今天 ${hhmmOf(top.time)}` : '今天'
  return {
    count,
    topTaskId: top.t.id,
    message: `今天有 ${count} 件你的事，最紧急的是「${top.t.title}」（${when}）。`
  }
}
