// tasks：任务的增删改查、过期标记与查重。
import { getDb } from './connection.ts'
import { deleteSourceRow } from './sources.ts'
import { deleteShot } from '../shotvault'
import { localNow } from '@shared/parsing'
import type { TaskRecord, TaskStatus } from '@shared/types'
import { randomUUID } from 'crypto'

// ---------- tasks ----------

interface TaskRow {
  id: string
  source_id: string | null
  title: string
  item_type: string
  belongs_to_user: string
  belonging_reason: string
  user_role: string
  start_time: string | null
  due_time: string | null
  location: string | null
  priority: string
  confidence: number
  suggested_action: string
  evidence: string
  notes: string
  duplicate_of: string | null
  status: string
  feedback: string | null
  tags: string
  checklist: string
  remind_offset_min: number | null
  reminded_at: string | null
  snoozed_until: string | null
  created_at: string
  updated_at: string
}

function rowToTask(r: TaskRow): TaskRecord {
  return {
    id: r.id,
    sourceId: r.source_id,
    title: r.title,
    itemType: r.item_type as TaskRecord['itemType'],
    belongsToUser: r.belongs_to_user as TaskRecord['belongsToUser'],
    belongingReason: r.belonging_reason,
    userRole: r.user_role as TaskRecord['userRole'],
    startTime: r.start_time,
    dueTime: r.due_time,
    location: r.location,
    priority: r.priority as TaskRecord['priority'],
    confidence: r.confidence,
    suggestedAction: r.suggested_action as TaskRecord['suggestedAction'],
    evidence: JSON.parse(r.evidence) as string[],
    notes: JSON.parse(r.notes || '[]') as string[],
    duplicateOf: r.duplicate_of,
    status: r.status as TaskStatus,
    feedback: r.feedback,
    tags: JSON.parse(r.tags || '[]') as string[],
    checklist: JSON.parse(r.checklist || '[]') as TaskRecord['checklist'],
    remindOffsetMin: r.remind_offset_min,
    remindedAt: r.reminded_at,
    snoozedUntil: r.snoozed_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** 提醒三字段是簿记状态、标签/清单可缺省，捕获链路的调用方不必关心。 */
type NewTask = Omit<
  TaskRecord,
  'id' | 'createdAt' | 'updatedAt' | 'tags' | 'checklist' | 'remindOffsetMin' | 'remindedAt' | 'snoozedUntil'
> & Partial<Pick<TaskRecord, 'tags' | 'checklist' | 'remindOffsetMin' | 'remindedAt' | 'snoozedUntil'>>

export function createTask(t: NewTask): TaskRecord {
  const now = localNow()
  const rec: TaskRecord = {
    ...t,
    tags: t.tags ?? [],
    checklist: t.checklist ?? [],
    remindOffsetMin: t.remindOffsetMin ?? null,
    remindedAt: t.remindedAt ?? null,
    snoozedUntil: t.snoozedUntil ?? null,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now
  }
  getDb().prepare(`
    INSERT INTO tasks (
      id, source_id, title, item_type, belongs_to_user, belonging_reason, user_role,
      start_time, due_time, location, priority, confidence, suggested_action,
      evidence, notes, duplicate_of, status, feedback, tags, checklist,
      remind_offset_min, reminded_at, snoozed_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.id, rec.sourceId, rec.title, rec.itemType, rec.belongsToUser, rec.belongingReason,
    rec.userRole, rec.startTime, rec.dueTime, rec.location, rec.priority, rec.confidence,
    rec.suggestedAction, JSON.stringify(rec.evidence), JSON.stringify(rec.notes), rec.duplicateOf,
    rec.status, rec.feedback, JSON.stringify(rec.tags), JSON.stringify(rec.checklist),
    rec.remindOffsetMin, rec.remindedAt, rec.snoozedUntil,
    rec.createdAt, rec.updatedAt
  )
  return rec
}

/** 已确认但超过截止时间的任务自动标记为已延期（文档 5.2）；进行中是用户显式选择，不覆盖 */
function markOverdue(): void {
  // 写入时间与判定阈值共用同一快照，避免两次 localNow() 跨分钟边界不一致
  const now = localNow()
  getDb().prepare(`
    UPDATE tasks SET status = 'overdue', updated_at = ?
    WHERE status IN ('not_started', 'scheduled')
      AND due_time IS NOT NULL AND due_time < ?
  `).run(now, now)
}

/** 是否已存在同名同截止时间的有效任务（重复提交去重） */
// 归一化标题：剥掉模型常加的动作词/虚词，只留事件主体，便于「同一事件不同表述」对照
const DUP_STRIP = /参加|参与|出席|列席|旁听|报名|提醒|记得|别忘了|去|到场/g
const normTitle = (t: string): string => t.replace(DUP_STRIP, '').replace(/[\s的了·,，。、:：]/g, '').toLowerCase()

/**
 * 模糊查重：识别「同一事件的不同表述」（「参加课题组会议」与「课题组会议」）。命中返回已有任务标题，否则 null。
 * 标题必须相等或有足够长度的包含关系，并且时间相同；只有日期的默认时间仍参与标题联合判断。
 */
export function findDuplicateTitle(title: string, startTime: string | null, dueTime: string | null): string | null {
  const candTime = dueTime ?? startTime
  const candNorm = normTitle(title)
  const rows = getDb()
    .prepare("SELECT title, start_time, due_time FROM tasks WHERE status != 'ignored'")
    .all() as { title: string; start_time: string | null; due_time: string | null }[]
  for (const r of rows) {
    const exTime = r.due_time ?? r.start_time
    const exNorm = normTitle(r.title)
    const similarTitle = candNorm && exNorm && (candNorm === exNorm || (
      Math.min(candNorm.length, exNorm.length) >= 4 && (candNorm.includes(exNorm) || exNorm.includes(candNorm))
    ))
    if (similarTitle) {
      const sameTime = candTime && exTime && candTime.slice(0, 16) === exTime.slice(0, 16)
      if (sameTime || (!candTime && !exTime)) return r.title
    }
  }
  return null
}

export function listTasks(): TaskRecord[] {
  markOverdue()
  const rows = getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as TaskRow[]
  return rows.map(rowToTask)
}

const TASK_EDITABLE: Record<string, string> = {
  title: 'title',
  itemType: 'item_type',
  startTime: 'start_time',
  dueTime: 'due_time',
  location: 'location',
  priority: 'priority',
  status: 'status',
  feedback: 'feedback',
  notes: 'notes',
  tags: 'tags',
  checklist: 'checklist',
  belongsToUser: 'belongs_to_user', // #15：允许用户改判归属（驱动个性化学习）
  remindOffsetMin: 'remind_offset_min'
}
// reminded_at / snoozed_until 不进 TASK_EDITABLE：只由提醒子系统经下面两个专用函数写。
const REMIND_RESET_KEYS = ['startTime', 'dueTime', 'remindOffsetMin'] as const

/** 提醒候选：窄查询，让 30 秒 tick 不必读全表，也不触发 markOverdue 的写库。 */
export function listReminderCandidates(): TaskRecord[] {
  const rows = getDb()
    .prepare(`
      SELECT * FROM tasks
      WHERE belongs_to_user = 'yes'
        AND status IN ('not_started', 'scheduled', 'in_progress', 'overdue')
        AND (start_time IS NOT NULL OR due_time IS NOT NULL)
    `)
    .all() as TaskRow[]
  return rows.map(rowToTask)
}

/** 记下已提醒的目标时刻（幂等键）。不清 snoozed_until——稍后的幂等靠 reminded_at === snoozed_until。 */
export function markTaskReminded(id: string, targetIso: string): void {
  getDb().prepare('UPDATE tasks SET reminded_at = ? WHERE id = ?').run(targetIso, id)
}

/** 稍后提醒到 untilIso。再次稍后时覆盖为更晚的时刻，幂等键自然失配、会重新兑现。 */
export function setTaskSnooze(id: string, untilIso: string): void {
  getDb().prepare('UPDATE tasks SET snoozed_until = ? WHERE id = ?').run(untilIso, id)
}

/** 单条任务（归属纠偏学习要读 title/belongingReason） */
export function getTask(id: string): TaskRecord | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

export function updateTask(id: string, patch: Partial<TaskRecord>): void {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [k, col] of Object.entries(TASK_EDITABLE)) {
    if (k in patch) {
      sets.push(`${col} = ?`)
      const v = (patch as Record<string, unknown>)[k]
      values.push(k === 'notes' || k === 'tags' || k === 'checklist' ? JSON.stringify(v) : v)
    }
  }
  if (!sets.length) return
  // 改了时间或提前量 → 复位提醒状态，让新时刻重新提醒一次；
  // 不复位的话旧的 snoozed_until 会一直挡着，新时刻永远提醒不出来。
  if (REMIND_RESET_KEYS.some((k) => k in patch)) {
    const cur = getDb()
      .prepare('SELECT start_time, due_time, remind_offset_min FROM tasks WHERE id = ?')
      .get(id) as { start_time: string | null; due_time: string | null; remind_offset_min: number | null } | undefined
    const changed =
      !!cur &&
      (('startTime' in patch && (patch.startTime ?? null) !== cur.start_time) ||
        ('dueTime' in patch && (patch.dueTime ?? null) !== cur.due_time) ||
        ('remindOffsetMin' in patch && (patch.remindOffsetMin ?? null) !== cur.remind_offset_min))
    if (changed) sets.push('reminded_at = NULL', 'snoozed_until = NULL')
  }
  sets.push('updated_at = ?')
  values.push(localNow(), id)
  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  // #3：任务标记完成 → 清掉其证据截图(隐私+省空间)；文字来源保留供回看/审核
  if (patch.status === 'done') {
    const t = getDb().prepare('SELECT source_id FROM tasks WHERE id = ?').get(id) as
      | { source_id: string | null }
      | undefined
    if (t?.source_id) deleteShot(t.source_id)
  }

  // 截止时间被清空或改到未来后，不应继续卡在"已延期"
  const row = getDb()
    .prepare('SELECT status, due_time, start_time FROM tasks WHERE id = ?')
    .get(id) as { status: string; due_time: string | null; start_time: string | null } | undefined
  if (row && row.status === 'overdue' && (!row.due_time || row.due_time > localNow())) {
    const next = row.due_time || row.start_time ? 'scheduled' : 'not_started'
    getDb().prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(next, localNow(), id)
  }
}

/** 用户明确确认 pending 草稿：归属与状态一起落库；普通状态编辑不代表归属确认。 */
export function confirmTasks(ids: string[]): void {
  const now = localNow()
  const stmt = getDb().prepare(`
    UPDATE tasks SET belongs_to_user = 'yes',
      status = CASE WHEN start_time IS NOT NULL OR due_time IS NOT NULL THEN 'scheduled' ELSE 'not_started' END,
      updated_at = ?
    WHERE id = ? AND status = 'pending'
  `)
  getDb().transaction(() => {
    for (const id of ids) stmt.run(now, id)
  })()
}

export function bulkUpdateStatus(ids: string[], status: TaskStatus): void {
  const stmt = getDb().prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
  const run = getDb().transaction((list: string[]) => {
    for (const id of list) stmt.run(status, localNow(), id)
  })
  run(ids)
}

/** 彻底删除任务；其来源若再无其他任务引用，连来源和证据截图一并清掉。 */
export function deleteTask(id: string): void {
  const t = getDb().prepare('SELECT source_id FROM tasks WHERE id = ?').get(id) as
    | { source_id: string | null }
    | undefined
  if (!t) return
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
  if (t.source_id) {
    const n = (getDb().prepare('SELECT count(*) AS n FROM tasks WHERE source_id = ?').get(t.source_id) as { n: number }).n
    if (n === 0) {
      deleteSourceRow(t.source_id)
      deleteShot(t.source_id)
    }
  }
}

/** 用户标签词表（按使用频次降序）：筛选条展示 + 解析预打标签的候选。 */
export function listTaskTags(): string[] {
  const rows = getDb().prepare("SELECT tags FROM tasks WHERE status != 'ignored'").all() as { tags: string }[]
  const freq = new Map<string, number>()
  for (const row of rows) {
    for (const tag of JSON.parse(row.tags || '[]') as string[]) freq.set(tag, (freq.get(tag) ?? 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
}
