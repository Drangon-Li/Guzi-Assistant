import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadEnv } from './env'
import { localNow } from '@shared/parsing'
import type {
  AppSettings,
  Profile,
  SourceRecord,
  SourceType,
  TaskRecord,
  TaskStatus
} from '@shared/types'

let db: Database.Database

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'al1.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content TEXT,
      file_path TEXT,
      created_at TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      title TEXT NOT NULL,
      item_type TEXT NOT NULL,
      belongs_to_user TEXT NOT NULL,
      belonging_reason TEXT NOT NULL,
      user_role TEXT NOT NULL,
      start_time TEXT,
      due_time TEXT,
      location TEXT,
      priority TEXT NOT NULL,
      confidence REAL NOT NULL,
      suggested_action TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL,
      feedback TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

export { localNow }

// ---------- profile ----------

export function getProfile(): Profile | null {
  const row = db.prepare('SELECT data FROM profile WHERE id = 1').get() as { data: string } | undefined
  return row ? (JSON.parse(row.data) as Profile) : null
}

export function saveProfile(p: Profile): void {
  db.prepare(
    'INSERT INTO profile (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  ).run(JSON.stringify(p))
}

// ---------- settings ----------

export function getSettings(): AppSettings {
  const env = loadEnv()
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return {
    hotkeyMode: (map.hotkeyMode as AppSettings['hotkeyMode']) || 'space_c',
    apiBase: map.apiBase || env.AL1_API_BASE || '',
    apiKey: map.apiKey || env.AL1_API_KEY || '',
    model: map.model || env.AL1_MODEL || 'gpt-5.5'
  }
}

export function saveSettings(patch: Partial<AppSettings>): void {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) stmt.run(k, String(v))
  }
}

// ---------- sources ----------

interface SourceRow {
  id: string
  type: string
  excerpt: string
  content: string | null
  file_path: string | null
  created_at: string
  deleted: number
}

function rowToSource(r: SourceRow): SourceRecord {
  return {
    id: r.id,
    type: r.type as SourceType,
    excerpt: r.excerpt,
    content: r.content,
    filePath: r.file_path,
    createdAt: r.created_at,
    deleted: !!r.deleted
  }
}

export function createSource(input: {
  type: SourceType
  excerpt: string
  content: string | null
  filePath: string | null
}): SourceRecord {
  const rec = {
    id: randomUUID(),
    ...input,
    createdAt: localNow(),
    deleted: false
  }
  db.prepare(
    'INSERT INTO sources (id, type, excerpt, content, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(rec.id, rec.type, rec.excerpt, rec.content, rec.filePath, rec.createdAt)
  return rec
}

export function getSource(id: string): SourceRecord | null {
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined
  return row ? rowToSource(row) : null
}

/** 删除来源原文，保留任务（文档第 8 节：来源可删除） */
export function deleteSourceContent(id: string): void {
  db.prepare(
    "UPDATE sources SET content = NULL, file_path = NULL, excerpt = '[来源已删除]', deleted = 1 WHERE id = ?"
  ).run(id)
}

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
  status: string
  feedback: string | null
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
    status: r.status as TaskStatus,
    feedback: r.feedback,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function createTask(
  t: Omit<TaskRecord, 'id' | 'createdAt' | 'updatedAt'>
): TaskRecord {
  const now = localNow()
  const rec: TaskRecord = { ...t, id: randomUUID(), createdAt: now, updatedAt: now }
  db.prepare(`
    INSERT INTO tasks (
      id, source_id, title, item_type, belongs_to_user, belonging_reason, user_role,
      start_time, due_time, location, priority, confidence, suggested_action,
      evidence, status, feedback, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.id, rec.sourceId, rec.title, rec.itemType, rec.belongsToUser, rec.belongingReason,
    rec.userRole, rec.startTime, rec.dueTime, rec.location, rec.priority, rec.confidence,
    rec.suggestedAction, JSON.stringify(rec.evidence), rec.status, rec.feedback,
    rec.createdAt, rec.updatedAt
  )
  return rec
}

/** 已确认但超过截止时间的任务自动标记为已延期（文档 5.2） */
function markOverdue(): void {
  db.prepare(`
    UPDATE tasks SET status = 'overdue', updated_at = ?
    WHERE status IN ('not_started', 'scheduled', 'in_progress')
      AND due_time IS NOT NULL AND due_time < ?
  `).run(localNow(), localNow())
}

export function listTasks(): TaskRecord[] {
  markOverdue()
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as TaskRow[]
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
  feedback: 'feedback'
}

export function updateTask(id: string, patch: Partial<TaskRecord>): void {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [k, col] of Object.entries(TASK_EDITABLE)) {
    if (k in patch) {
      sets.push(`${col} = ?`)
      values.push((patch as Record<string, unknown>)[k])
    }
  }
  if (!sets.length) return
  sets.push('updated_at = ?')
  values.push(localNow(), id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function bulkUpdateStatus(ids: string[], status: TaskStatus): void {
  const stmt = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
  const run = db.transaction((list: string[]) => {
    for (const id of list) stmt.run(status, localNow(), id)
  })
  run(ids)
}

export function wipeAll(): void {
  db.exec('DELETE FROM tasks; DELETE FROM sources; DELETE FROM profile;')
}
