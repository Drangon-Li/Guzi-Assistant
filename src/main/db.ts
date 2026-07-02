import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadEnv } from './env'
import { deleteShot } from './shotvault'
import { localNow } from '@shared/parsing'
import { buildFtsQuery } from '@shared/fts-query'
import type {
  AppSettings,
  AppUsageEntry,
  DetectionRecord,
  MemoryHit,
  ReportRecord,
  WorkRecord,
  Profile,
  SourceRecord,
  SourceType,
  TaskRecord,
  TaskStatus
} from '@shared/types'

let db: Database.Database
let ftsReady = false // #52 FTS5 是否可用；不可用则记忆检索退化为 LIKE

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'eshell.db'))
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
      notes TEXT NOT NULL DEFAULT '[]',
      duplicate_of TEXT,
      status TEXT NOT NULL,
      feedback TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS detections (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      time_iso TEXT,
      deadline INTEGER NOT NULL DEFAULT 0,
      source_text TEXT NOT NULL,
      hits TEXT NOT NULL DEFAULT '[]',
      app TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_records (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      app TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_usage (
      day TEXT NOT NULL,
      app TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, app)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'daily',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_memory (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS focus_tasks (
      name TEXT PRIMARY KEY,
      hidden INTEGER NOT NULL DEFAULT 0,
      custom INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `)
  // 老库迁移：work_records 后加 task 列（专注归并）、personal_memory 后加 base_content（基本画像）
  const wrCols = (db.prepare('PRAGMA table_info(work_records)').all() as { name: string }[]).map((c) => c.name)
  if (!wrCols.includes('task')) db.exec('ALTER TABLE work_records ADD COLUMN task TEXT')
  const pmCols = (db.prepare('PRAGMA table_info(personal_memory)').all() as { name: string }[]).map((c) => c.name)
  if (!pmCols.includes('base_content'))
    db.exec("ALTER TABLE personal_memory ADD COLUMN base_content TEXT NOT NULL DEFAULT ''")
  // 老数据清理：应用时长早期把自己（dev 下前台名是 Electron）也计了进去，启动时清掉（新数据已不再产生）
  db.exec("DELETE FROM app_usage WHERE app IN ('Electron', 'EShell', '纸壳助手')")

  // 老库迁移：早期版本没有 notes 列
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!taskCols.includes('notes')) {
    db.exec("ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'")
  }
  if (!taskCols.includes('duplicate_of')) {
    db.exec('ALTER TABLE tasks ADD COLUMN duplicate_of TEXT')
  }

  // #52 可搜索记忆底座：FTS5(trigram 支持中文子串) 索引来源文本。standalone 表 + 手动同步。
  // 隐私中立——只索引 sources 里**已持久化**的文本，不新增任何落盘（截图持久化/加密见 #52 后续 + #53）。
  // 防御：trigram/FTS5 万一不可用，不能让 initDb 抛错把整个 app 卡死启动 → 退化为 LIKE 检索。
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(source_id UNINDEXED, body, tokenize='trigram')"
    )
    // 首次/老库：回填已有未删除来源
    const ftsN = (db.prepare('SELECT count(*) AS n FROM sources_fts').get() as { n: number }).n
    if (ftsN === 0) {
      const rows = db
        .prepare('SELECT id, excerpt, content FROM sources WHERE deleted = 0')
        .all() as { id: string; excerpt: string; content: string | null }[]
      const ins = db.prepare('INSERT INTO sources_fts (source_id, body) VALUES (?, ?)')
      db.transaction((list: typeof rows) => {
        for (const r of list) ins.run(r.id, `${r.excerpt}\n${r.content ?? ''}`)
      })(rows)
    }
    ftsReady = true
  } catch (e) {
    ftsReady = false // FTS5/trigram 不可用：searchSources 走 LIKE，索引调用变 no-op
    console.error('[memory] FTS5 初始化失败，退化为 LIKE 检索：', e)
  }
}

function indexSourceFts(id: string, excerpt: string, content: string | null): void {
  if (!ftsReady) return
  db.prepare('INSERT INTO sources_fts (source_id, body) VALUES (?, ?)').run(
    id,
    `${excerpt}\n${content ?? ''}`
  )
}
function unindexSourceFts(id: string): void {
  if (!ftsReady) return
  db.prepare('DELETE FROM sources_fts WHERE source_id = ?').run(id)
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
  // 兼容旧版本存的 hotkeyMode 枚举
  const legacy: Record<string, string> = {
    alt_c: 'Alt+C',
    alt_space: 'Alt+Space',
    cmd_shift_c: 'CommandOrControl+Shift+C'
  }
  return {
    hotkey: map.hotkey || legacy[map.hotkeyMode] || 'Control+\\',
    screenshotHotkey: map.screenshotHotkey || 'Control+Shift+\\',
    // ?? 而不是 ||：用户显式清空后不能从 .env 静默复活
    apiBase: map.apiBase ?? env.ESHELL_API_BASE ?? '',
    apiKey: map.apiKey ?? env.ESHELL_API_KEY ?? '',
    model: map.model || env.ESHELL_MODEL || 'gpt-5.5',
    feishuAppId: map.feishuAppId ?? env.ESHELL_FEISHU_APP_ID ?? '',
    feishuAppSecret: map.feishuAppSecret ?? env.ESHELL_FEISHU_APP_SECRET ?? '',
    // 核心被动采集：默认关（opt-in，检测走云端解析、消耗 credits）
    screenSenseEnabled: map.screenSenseEnabled === 'true',
    screenSenseHotkey: map.screenSenseHotkey || 'Alt+S',
    screenSenseContinuous: map.screenSenseContinuous !== 'false',
    screenSenseIntervalSec: Number(map.screenSenseIntervalSec) || 5,
    // 排除名单空 = 不排除（不能像关键词那样回退默认词表）
    screenSenseExcludedApps: parseList(map.screenSenseExcludedApps),
    screenSenseKeepShots: map.screenSenseKeepShots !== 'false',
    screenSenseRetentionDays: map.screenSenseRetentionDays != null ? Number(map.screenSenseRetentionDays) : 14,
    screenSensePopup: map.screenSensePopup !== 'false',
    screenSenseWorkLog: map.screenSenseWorkLog !== 'false',
    screenSenseVlmConfirm: map.screenSenseVlmConfirm === 'true',
    dailyReportTime: map.dailyReportTime ?? '',
    screenSenseCardHideSec:
      map.screenSenseCardHideSec != null ? Number(map.screenSenseCardHideSec) : 60,
    assistantAutoCloseSec: map.assistantAutoCloseSec != null ? Number(map.assistantAutoCloseSec) : 60,
    theme: map.theme === 'light' || map.theme === 'dark' ? map.theme : 'system'
  }
}

/** 逗号存储字符串 → 数组；空则返回空数组（无默认） */
function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
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
  indexSourceFts(rec.id, rec.excerpt, rec.content) // #52 入记忆检索索引
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
  unindexSourceFts(id) // 原文删了就不该再被搜到
}

/** 整行删除：解析失败时清理孤儿来源，避免无任务引用的原文滞留 */
export function deleteSourceRow(id: string): void {
  db.prepare('DELETE FROM sources WHERE id = ?').run(id)
  unindexSourceFts(id)
}

/**
 * #52 记忆检索：按关键词搜已索引的来源文本，定位回来源与其派生任务。
 * trigram 对中文子串有效（≥3 字）；过短查询或 FTS 异常 → LIKE 兜底。只返回未删除来源。
 */
export function searchSources(query: string, limit = 50): MemoryHit[] {
  const trimmed = (query ?? '').trim()
  if (!trimmed) return []
  let rows: { id: string; snippet: string }[] = []
  const match = buildFtsQuery(trimmed)
  const compact = trimmed.replace(/\s+/g, '')
  if (ftsReady && match && compact.length >= 3) {
    try {
      rows = db
        .prepare(
          `SELECT source_id AS id, snippet(sources_fts, 1, '〖', '〗', '…', 16) AS snippet
           FROM sources_fts WHERE sources_fts MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(match, limit) as { id: string; snippet: string }[]
    } catch {
      rows = []
    }
  }
  if (!rows.length) {
    const like = `%${trimmed.replace(/[%_\\]/g, '')}%`
    rows = db
      .prepare(
        `SELECT id, substr(IFNULL(content, excerpt), 1, 80) AS snippet FROM sources
         WHERE deleted = 0 AND (content LIKE ? OR excerpt LIKE ?) ORDER BY created_at DESC LIMIT ?`
      )
      .all(like, like, limit) as { id: string; snippet: string }[]
  }
  const getOne = db.prepare('SELECT * FROM sources WHERE id = ? AND deleted = 0')
  const countTasks = db.prepare('SELECT count(*) AS n FROM tasks WHERE source_id = ?')
  const out: MemoryHit[] = []
  for (const r of rows) {
    const srow = getOne.get(r.id) as SourceRow | undefined
    if (!srow) continue
    out.push({
      source: rowToSource(srow),
      snippet: r.snippet,
      taskCount: (countTasks.get(r.id) as { n: number }).n
    })
  }
  return out
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
  notes: string
  duplicate_of: string | null
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
    notes: JSON.parse(r.notes || '[]') as string[],
    duplicateOf: r.duplicate_of,
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
      evidence, notes, duplicate_of, status, feedback, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.id, rec.sourceId, rec.title, rec.itemType, rec.belongsToUser, rec.belongingReason,
    rec.userRole, rec.startTime, rec.dueTime, rec.location, rec.priority, rec.confidence,
    rec.suggestedAction, JSON.stringify(rec.evidence), JSON.stringify(rec.notes), rec.duplicateOf,
    rec.status, rec.feedback, rec.createdAt, rec.updatedAt
  )
  return rec
}

/** 已确认但超过截止时间的任务自动标记为已延期（文档 5.2）；进行中是用户显式选择，不覆盖 */
function markOverdue(): void {
  // 写入时间与判定阈值共用同一快照，避免两次 localNow() 跨分钟边界不一致
  const now = localNow()
  db.prepare(`
    UPDATE tasks SET status = 'overdue', updated_at = ?
    WHERE status IN ('not_started', 'scheduled')
      AND due_time IS NOT NULL AND due_time < ?
  `).run(now, now)
}

/** 是否已存在同名同截止时间的有效任务（重复提交去重） */
const hasClock = (iso: string | null): boolean => !!iso && iso.slice(11, 16) !== '00:00'
// 归一化标题：剥掉模型常加的动作词/虚词，只留事件主体，便于「同一事件不同表述」对照
const DUP_STRIP = /参加|参与|出席|列席|旁听|报名|提醒|记得|别忘了|去|到场/g
const normTitle = (t: string): string => t.replace(DUP_STRIP, '').replace(/[\s的了·,，。、:：]/g, '').toLowerCase()

/**
 * 模糊查重：识别「同一事件的不同表述」（本地「开会」与云端「参加华师大会议」=同一个会）。命中返回已有任务标题，否则 null。
 * 信号：① 两者都带具体钟点且分钟级相等（同一时刻=同一事件，强信号）；② 归一化标题相等/互相包含 + 同日。
 * 注：比旧 taskExists（标题+时间完全相等）更宽，代价是同一时刻的两件不同事可能被误判为重复。
 */
export function findDuplicateTitle(title: string, startTime: string | null, dueTime: string | null): string | null {
  const candTime = dueTime ?? startTime
  const candNorm = normTitle(title)
  const rows = db
    .prepare("SELECT title, start_time, due_time FROM tasks WHERE status != 'ignored'")
    .all() as { title: string; start_time: string | null; due_time: string | null }[]
  for (const r of rows) {
    const exTime = r.due_time ?? r.start_time
    if (hasClock(candTime) && hasClock(exTime) && candTime!.slice(0, 16) === exTime!.slice(0, 16)) return r.title
    const exNorm = normTitle(r.title)
    if (candNorm && exNorm && (candNorm === exNorm || candNorm.includes(exNorm) || exNorm.includes(candNorm))) {
      const sameDay = candTime && exTime && candTime.slice(0, 10) === exTime.slice(0, 10)
      if (sameDay || (!candTime && !exTime)) return r.title
    }
  }
  return null
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
  feedback: 'feedback',
  notes: 'notes',
  belongsToUser: 'belongs_to_user' // #15：允许用户改判归属（驱动个性化学习）
}

/** 单条任务（归属纠偏学习要读 title/belongingReason） */
export function getTask(id: string): TaskRecord | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

export function updateTask(id: string, patch: Partial<TaskRecord>): void {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [k, col] of Object.entries(TASK_EDITABLE)) {
    if (k in patch) {
      sets.push(`${col} = ?`)
      const v = (patch as Record<string, unknown>)[k]
      values.push(k === 'notes' ? JSON.stringify(v) : v)
    }
  }
  if (!sets.length) return
  sets.push('updated_at = ?')
  values.push(localNow(), id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  // #3：任务标记完成 → 清掉其证据截图(隐私+省空间)；文字来源保留供回看/审核
  if (patch.status === 'done') {
    const t = db.prepare('SELECT source_id FROM tasks WHERE id = ?').get(id) as
      | { source_id: string | null }
      | undefined
    if (t?.source_id) deleteShot(t.source_id)
  }

  // 截止时间被清空或改到未来后，不应继续卡在"已延期"
  const row = db
    .prepare('SELECT status, due_time, start_time FROM tasks WHERE id = ?')
    .get(id) as { status: string; due_time: string | null; start_time: string | null } | undefined
  if (row && row.status === 'overdue' && (!row.due_time || row.due_time > localNow())) {
    const next = row.due_time || row.start_time ? 'scheduled' : 'not_started'
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(next, localNow(), id)
  }
}

export function bulkUpdateStatus(ids: string[], status: TaskStatus): void {
  const stmt = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
  const run = db.transaction((list: string[]) => {
    for (const id of list) stmt.run(status, localNow(), id)
  })
  run(ids)
}

// ---------- detections（屏幕感知本地检测历史，被动留存进「记忆」页）----------

interface DetectionRow {
  id: string
  title: string
  time_iso: string | null
  deadline: number
  source_text: string
  hits: string
  app: string | null
  status: string
  created_at: string
}

function rowToDetection(r: DetectionRow): DetectionRecord {
  return {
    id: r.id,
    title: r.title,
    timeIso: r.time_iso,
    deadline: !!r.deadline,
    sourceText: r.source_text,
    hits: JSON.parse(r.hits || '[]'),
    app: r.app,
    status: r.status as DetectionRecord['status'],
    createdAt: r.created_at
  }
}

/**
 * 记一条屏幕检测。**跨所有状态**按 标题+时间 去重：只要这条内容记录过（待处理/已忽略/已加入），
 * 就返回旧记录且 isNew=false —— 调用方据此不再重复弹窗/抓取（修「拒绝后仍重复抓取」）。
 */
export function addDetection(input: {
  title: string
  timeIso: string | null
  deadline: boolean
  sourceText: string
  hits: string[]
  app: string | null
}): { detection: DetectionRecord; isNew: boolean } {
  const dup = db
    .prepare("SELECT * FROM detections WHERE title=? AND IFNULL(time_iso,'')=IFNULL(?,'')")
    .get(input.title, input.timeIso) as DetectionRow | undefined
  if (dup) return { detection: rowToDetection(dup), isNew: false }

  const rec: DetectionRecord = {
    id: randomUUID(),
    title: input.title,
    timeIso: input.timeIso,
    deadline: input.deadline,
    sourceText: input.sourceText,
    hits: input.hits,
    app: input.app,
    status: 'new',
    createdAt: localNow()
  }
  db.prepare(
    'INSERT INTO detections (id, title, time_iso, deadline, source_text, hits, app, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    rec.id,
    rec.title,
    rec.timeIso,
    rec.deadline ? 1 : 0,
    rec.sourceText,
    JSON.stringify(rec.hits),
    rec.app,
    rec.status,
    rec.createdAt
  )
  // 历史不无界增长：只保留最近 300 条
  db.exec(
    'DELETE FROM detections WHERE id NOT IN (SELECT id FROM detections ORDER BY created_at DESC LIMIT 300)'
  )
  return { detection: rec, isNew: true }
}

export function listDetections(limit = 40): DetectionRecord[] {
  const rows = db
    .prepare('SELECT * FROM detections ORDER BY created_at DESC LIMIT ?')
    .all(limit) as DetectionRow[]
  return rows.map(rowToDetection)
}

export function getDetection(id: string): DetectionRecord | null {
  const row = db.prepare('SELECT * FROM detections WHERE id = ?').get(id) as DetectionRow | undefined
  return row ? rowToDetection(row) : null
}

export function setDetectionStatus(id: string, status: DetectionRecord['status']): void {
  db.prepare('UPDATE detections SET status = ? WHERE id = ?').run(status, id)
}

// ---------- work_records（工作记录：屏幕识别顺带的「在做什么」时间线，供日报生成）----------

const WORK_RECORDS_CAP = 5000 // 只留最近 N 条，避免无界增长

interface WorkRecordRow {
  id: string
  content: string
  app: string | null
  task: string | null
  created_at: string
}
const rowToWorkRecord = (r: WorkRecordRow): WorkRecord => ({
  id: r.id,
  content: r.content,
  app: r.app,
  task: r.task,
  createdAt: r.created_at
})

export function addWorkRecord(w: { content: string; app: string | null; task?: string | null }): WorkRecord {
  const rec = {
    id: randomUUID(),
    content: w.content.slice(0, 200),
    app: w.app,
    task: w.task ?? null,
    createdAt: localNow()
  }
  db.prepare('INSERT INTO work_records (id, content, app, task, created_at) VALUES (?, ?, ?, ?, ?)').run(
    rec.id,
    rec.content,
    rec.app,
    rec.task,
    rec.createdAt
  )
  db.prepare(
    'DELETE FROM work_records WHERE id NOT IN (SELECT id FROM work_records ORDER BY created_at DESC LIMIT ?)'
  ).run(WORK_RECORDS_CAP)
  return rec
}

/** 某天（YYYY-MM-DD）的工作记录，按时间正序。 */
export function listWorkRecords(day: string): WorkRecord[] {
  const rows = db
    .prepare('SELECT * FROM work_records WHERE created_at LIKE ? ORDER BY created_at')
    .all(`${day}%`) as WorkRecordRow[]
  return rows.map(rowToWorkRecord)
}

export function deleteWorkRecord(id: string): void {
  db.prepare('DELETE FROM work_records WHERE id = ?').run(id)
}

// ---------- app_usage（前台应用使用时长，按天累计；只存应用名与秒数，不存内容）----------

export function addAppUsage(day: string, app: string, seconds: number): void {
  db.prepare(
    'INSERT INTO app_usage (day, app, seconds) VALUES (?, ?, ?) ON CONFLICT(day, app) DO UPDATE SET seconds = seconds + excluded.seconds'
  ).run(day, app, seconds)
}

/** 某天各应用使用时长，按时长降序。 */
export function appUsageSummary(day: string): AppUsageEntry[] {
  return db
    .prepare('SELECT app, seconds FROM app_usage WHERE day = ? ORDER BY seconds DESC')
    .all(day) as AppUsageEntry[]
}

// ---------- reports（AI 生成的工作日报）----------

interface ReportRow {
  id: string
  day: string
  type: string
  title: string
  content: string
  created_at: string
}
const rowToReport = (r: ReportRow): ReportRecord => ({
  id: r.id,
  day: r.day,
  type: 'daily',
  title: r.title,
  content: r.content,
  createdAt: r.created_at
})

export function addReport(r: { day: string; title: string; content: string }): ReportRecord {
  const rec = {
    id: randomUUID(),
    day: r.day,
    type: 'daily' as const,
    title: r.title,
    content: r.content,
    createdAt: localNow()
  }
  db.prepare('INSERT INTO reports (id, day, type, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    rec.id,
    rec.day,
    rec.type,
    rec.title,
    rec.content,
    rec.createdAt
  )
  return rec
}

export function listReports(limit = 100): ReportRecord[] {
  const rows = db
    .prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?')
    .all(limit) as ReportRow[]
  return rows.map(rowToReport)
}

export function deleteReport(id: string): void {
  db.prepare('DELETE FROM reports WHERE id = ?').run(id)
}

// ---------- personal_memory（两段画像：base=用户身份的长期定义（手动维护），recent=近期行为/任务画像（AI 归纳））----------

export interface PersonalMemory {
  /** 基本画像：用户身份的长期定义，手动维护 */
  base: string
  /** 近期行为画像：AI 从近期工作记录归纳，可刷新 */
  recent: string
  updatedAt: string | null
}

export function getPersonalMemory(): PersonalMemory {
  const row = db
    .prepare('SELECT base_content, content, updated_at FROM personal_memory WHERE id = 1')
    .get() as { base_content: string; content: string; updated_at: string | null } | undefined
  return { base: row?.base_content ?? '', recent: row?.content ?? '', updatedAt: row?.updated_at ?? null }
}

/** 更新画像的某一段（另一段保持原值），返回最新完整画像。 */
export function setPersonalMemory(part: 'base' | 'recent', content: string): PersonalMemory {
  const cur = getPersonalMemory()
  const next = { base: part === 'base' ? content : cur.base, recent: part === 'recent' ? content : cur.recent }
  const updatedAt = localNow()
  db.prepare(
    'INSERT INTO personal_memory (id, base_content, content, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET base_content = excluded.base_content, content = excluded.content, updated_at = excluded.updated_at'
  ).run(next.base, next.recent, updatedAt)
  return { ...next, updatedAt }
}

/** 注入 prompt 用：两段画像拼接（空段省略）。 */
export function personalMemoryText(): string {
  const m = getPersonalMemory()
  const parts: string[] = []
  if (m.base.trim()) parts.push(`【基本画像】\n${m.base.trim()}`)
  if (m.recent.trim()) parts.push(`【近期行为画像】\n${m.recent.trim()}`)
  return parts.join('\n')
}

// ---------- focus_tasks（任务专注：用户自定义/隐藏的任务名偏好，用于校正模型的任务归并）----------

export interface FocusTaskPref {
  name: string
  hidden: boolean
  custom: boolean
}

export function listFocusTaskPrefs(): FocusTaskPref[] {
  const rows = db.prepare('SELECT name, hidden, custom FROM focus_tasks').all() as {
    name: string
    hidden: number
    custom: number
  }[]
  return rows.map((r) => ({ name: r.name, hidden: !!r.hidden, custom: !!r.custom }))
}

export function addFocusTask(name: string): void {
  const n = name.trim().slice(0, 60)
  if (!n) return
  db.prepare(
    'INSERT INTO focus_tasks (name, hidden, custom, created_at) VALUES (?, 0, 1, ?) ON CONFLICT(name) DO UPDATE SET hidden = 0'
  ).run(n, localNow())
}

/** 「删除」一个任务：标记隐藏（不进展示、不进模型候选）。 */
export function hideFocusTask(name: string): void {
  db.prepare(
    'INSERT INTO focus_tasks (name, hidden, custom, created_at) VALUES (?, 1, 0, ?) ON CONFLICT(name) DO UPDATE SET hidden = 1'
  ).run(name, localNow())
}

/** 模型的任务名候选：近 3 天出现过的任务 + 用户自定义，剔除隐藏，最多 12 个。 */
export function listFocusTaskCandidates(): string[] {
  const since = new Date()
  since.setDate(since.getDate() - 3)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sinceKey = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`
  const derived = (
    db
      .prepare(
        'SELECT DISTINCT task FROM work_records WHERE task IS NOT NULL AND created_at >= ? ORDER BY created_at DESC'
      )
      .all(sinceKey) as { task: string }[]
  ).map((r) => r.task)
  const prefs = listFocusTaskPrefs()
  const hidden = new Set(prefs.filter((p) => p.hidden).map((p) => p.name))
  const custom = prefs.filter((p) => p.custom && !p.hidden).map((p) => p.name)
  return [...new Set([...custom, ...derived])].filter((n) => !hidden.has(n)).slice(0, 12)
}

/** 近 N 天工作记录（供个人记忆归纳/活动时间线）。 */
export function listWorkRecordsSince(sinceDay: string): WorkRecord[] {
  const rows = db
    .prepare('SELECT * FROM work_records WHERE created_at >= ? ORDER BY created_at')
    .all(sinceDay) as WorkRecordRow[]
  return rows.map(rowToWorkRecord)
}

/** 数据导出：某时间范围（含端点，日键比较）内的工作记录/日报/应用时长/检测。 */
export function exportRange(fromDay: string, toDay: string): Record<string, unknown> {
  const hi = `${toDay}￿`
  return {
    exportedAt: localNow(),
    range: { from: fromDay, to: toDay },
    workRecords: (
      db
        .prepare('SELECT * FROM work_records WHERE created_at >= ? AND created_at <= ? ORDER BY created_at')
        .all(fromDay, hi) as WorkRecordRow[]
    ).map(rowToWorkRecord),
    reports: db
      .prepare('SELECT id, day, type, title, content, created_at AS createdAt FROM reports WHERE day >= ? AND day <= ? ORDER BY day')
      .all(fromDay, toDay),
    appUsage: db
      .prepare('SELECT day, app, seconds FROM app_usage WHERE day >= ? AND day <= ? ORDER BY day, seconds DESC')
      .all(fromDay, toDay),
    detections: db
      .prepare(
        'SELECT id, title, time_iso AS timeIso, status, app, created_at AS createdAt FROM detections WHERE created_at >= ? AND created_at <= ? ORDER BY created_at'
      )
      .all(fromDay, hi)
  }
}

export function wipeAll(): void {
  db.exec(
    'DELETE FROM tasks; DELETE FROM sources; DELETE FROM detections; DELETE FROM profile; DELETE FROM work_records; DELETE FROM app_usage; DELETE FROM reports; DELETE FROM personal_memory; DELETE FROM focus_tasks;'
  )
  // SQLite 删除只标记页空闲，原文字节仍留在文件里；清数据要真正回收
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
}

/** 清空「记忆」：来源历史(sources+FTS)、屏幕识别历史(detections)、工作记录与个人画像。保留任务/档案/日报。 */
export function wipeMemory(): void {
  db.exec(
    'DELETE FROM sources; DELETE FROM sources_fts; DELETE FROM detections; DELETE FROM work_records; DELETE FROM personal_memory; DELETE FROM focus_tasks;'
  )
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
}
