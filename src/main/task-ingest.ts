// ParsedItem → 任务落库的统一映射：capture / assistant / detection-cards 三条接受流共用。
// 新增任务字段只改这一处，避免三份 15 字段映射各自漂移。
import { createTask } from './db'
import type { ParsedItem } from '@shared/parsing'
import type { TaskRecord, TaskStatus } from '@shared/types'

export function createTaskFromItem(
  sourceId: string,
  item: ParsedItem,
  status: TaskStatus,
  explicitlyAccepted = false
): TaskRecord {
  return createTask({
    sourceId,
    title: item.title,
    itemType: item.item_type,
    belongsToUser: explicitlyAccepted ? 'yes' : item.belongs_to_user,
    belongingReason: item.belonging_reason,
    userRole: item.user_role,
    startTime: item.start_time,
    dueTime: item.due_time,
    location: item.location,
    priority: item.priority,
    confidence: item.confidence,
    suggestedAction: item.suggested_action,
    evidence: item.evidence,
    notes: item.notes,
    tags: item.tags ?? [],
    duplicateOf: item.duplicate_of,
    status,
    feedback: null
  })
}

/** 接受流通用状态判定：解出时间即 scheduled，否则 not_started。 */
export function scheduledStatus(item: ParsedItem): TaskStatus {
  return item.due_time || item.start_time ? 'scheduled' : 'not_started'
}
