// 任务分类纯函数。注入 now 便于测试。
import type { TaskRecord } from './types'

// 仍在「未完成」语义里、且非 overdue（overdue 由 due_time 驱动，纯开始时间任务不会进 overdue）
const ACTIVE_NON_OVERDUE = new Set(['not_started', 'scheduled', 'in_progress'])

/**
 * 「已结束的纯开始时间任务」：有开始时间、无截止时间、开始时间已过、仍是未完成状态。
 * 典型是「开过的会」——既不会变 overdue（没有 due_time），也没有完成动作，会永远滞留在「全部未完成」。
 * 供时间轴把它们收进可折叠的「已结束」分组、并从主列表排除（见 #9）。
 */
export function isFinishedEvent(task: TaskRecord, now: Date): boolean {
  if (!ACTIVE_NON_OVERDUE.has(task.status)) return false
  if (task.dueTime) return false
  if (!task.startTime) return false
  const t = new Date(task.startTime).getTime()
  return !Number.isNaN(t) && t < now.getTime()
}
