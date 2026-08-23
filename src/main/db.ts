import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadEnv } from './env'
import { deleteShot } from './shotvault'
import { localNow, localNowSec } from '@shared/parsing'
import { dayKey, normalizeTaskKey, normalizeTaskLabel } from '@shared/work-report'
import { buildFtsQuery } from '@shared/fts-query'
import { firstNonBlank } from '@shared/env-value'
import { resolveDirectModelSettings } from '@shared/model-configuration'
import { normalizeHistoryHost } from '@shared/history'
import { createSqliteHistorySegmentIndex, type HistorySegmentIndex } from './history/segment-index.ts'
import { createSqliteHistorySummaryIndex, type HistorySummaryIndex } from './history/summary-index.ts'
import { migrateWorkRecords, scrubInvalidTaskNames } from './db-migrations.ts'
import type {
  AppSettings,
  AppCategoryOverride,
  AppSwitchRecord,
  AppUsageEntry,
  ActivityHistorySegmentRecord,
  DetectionRecord,
  MemoryHit,
  ReportRecord,
  WorkRecord,
  OcrEvidenceRecord,
  Profile,
  SourceRecord,
  SourceType,
  TaskRecord,
  TaskStatus,
  HistoryDerivedWorkRecordInput,
  WorkRecordSource,
  HistoryAppSelection
} from '@shared/types'

let db: Database.Database
let ftsReady = false // #52 FTS5 是否可用；不可用则记忆检索退化为 LIKE
let historySegmentIndex: HistorySegmentIndex | null = null
let historySummaryIndex: HistorySummaryIndex | null = null

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
      task TEXT,
      evidence_source TEXT NOT NULL DEFAULT 'ocr',
      segment_id TEXT,
      start_at TEXT,
      end_at TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      summary_hash TEXT,
      derived_by TEXT NOT NULL DEFAULT 'legacy',
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
    CREATE TABLE IF NOT EXISTS detection_notes (
      id TEXT PRIMARY KEY,
      detection_id TEXT,
      title TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_switches (
      ts TEXT NOT NULL,
      from_app TEXT,
      to_app TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_switches_ts ON app_switches(ts);
    CREATE TABLE IF NOT EXISTS app_categories (
      app TEXT PRIMARY KEY,
      category TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_segments (
      id TEXT PRIMARY KEY,
      bucket_kind TEXT NOT NULL,
      bucket_start TEXT NOT NULL,
      bucket_end TEXT NOT NULL,
      first_event_at TEXT NOT NULL,
      last_event_at TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      meaningful_event_count INTEGER NOT NULL,
      semantic_complete_count INTEGER NOT NULL DEFAULT 0,
      semantic_partial_count INTEGER NOT NULL DEFAULT 0,
      semantic_empty_count INTEGER NOT NULL DEFAULT 0,
      ocr_evidence_count INTEGER NOT NULL DEFAULT 0,
      trigger_reasons TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_segments_bucket ON activity_segments(bucket_kind, bucket_start);
    CREATE TABLE IF NOT EXISTS ocr_evidence (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      segment_id TEXT,
      occurred_at TEXT NOT NULL,
      app_name TEXT,
      bundle_id TEXT,
      window_title TEXT,
      semantic_score INTEGER NOT NULL,
      trigger_reason TEXT NOT NULL,
      redaction_hits TEXT NOT NULL DEFAULT '[]',
      redacted_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ocr_evidence_occurred ON ocr_evidence(occurred_at);
  `)
  historySegmentIndex = createSqliteHistorySegmentIndex(db)
  historySummaryIndex = createSqliteHistorySummaryIndex(db)
  // 老库迁移：work_records 只增不删，保留旧 OCR 记录并标记为 legacy。
  migrateWorkRecords(db)
  // 老数据清理：裸 App 名/泛化名/窗口标题残片的 task 标签置空（不进统计、不进模型候选）
  scrubInvalidTaskNames(db)
  const pmCols = (db.prepare('PRAGMA table_info(personal_memory)').all() as { name: string }[]).map((c) => c.name)
  if (!pmCols.includes('base_content'))
    db.exec("ALTER TABLE personal_memory ADD COLUMN base_content TEXT NOT NULL DEFAULT ''")
  // 老数据清理：应用时长早期把自己（dev 下前台名是 Electron）也计了进去，启动时清掉（新数据已不再产生）
  db.exec(
    "DELETE FROM app_usage WHERE app IN ('Electron', 'GuziAssistant', 'Guzi Assistant', 'EShell', 'Gooz', '谷子助手', '纸壳助手')"
  )
  // 切换事件只服务注意力分析，90 天后没有回看价值，启动时滚动清理
  const switchCutoff = dayKey(new Date(Date.now() - 90 * 86_400_000))
  db.prepare('DELETE FROM app_switches WHERE ts < ?').run(switchCutoff)
  db.prepare('DELETE FROM ocr_evidence WHERE occurred_at < ?').run(
    new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  )
  cleanupStaleDetections()

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

export function getHistorySegmentIndex(): HistorySegmentIndex {
  if (!historySegmentIndex) throw new Error('database has not been initialized')
  return historySegmentIndex
}

export function getHistorySummaryIndex(): HistorySummaryIndex {
  if (!historySummaryIndex) throw new Error('database has not been initialized')
  return historySummaryIndex
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

export function localDateTimeAt(timestampMs: number): string {
  const d = new Date(timestampMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
  const directModel = resolveDirectModelSettings(map, env)
  // 兼容旧版本存的 hotkeyMode 枚举
  const legacy: Record<string, string> = {
    alt_c: 'Alt+C',
    alt_space: 'Alt+Space',
    cmd_shift_c: 'CommandOrControl+Shift+C'
  }
  return {
    hotkey: map.hotkey || legacy[map.hotkeyMode] || 'Control+\\',
    screenshotHotkey: map.screenshotHotkey || 'Control+Shift+\\',
    mainWindowHotkey: map.mainWindowHotkey || 'Alt+G',
    petVoiceHotkey: map.petVoiceHotkey || 'Alt+V',
    quickAskHotkey: map.quickAskHotkey || 'Alt+Space',
    // ?? 而不是 ||：用户显式清空后不能从 .env 静默复活
    apiBase: directModel.apiBase,
    apiKey: directModel.apiKey,
    model: directModel.model,
    feishuAppId:
      map.feishuAppId ??
      firstNonBlank(env.GUZI_ASSISTANT_FEISHU_APP_ID, env.ESHELL_FEISHU_APP_ID),
    feishuAppSecret:
      map.feishuAppSecret ??
      firstNonBlank(env.GUZI_ASSISTANT_FEISHU_APP_SECRET, env.ESHELL_FEISHU_APP_SECRET),
    // 核心被动采集：默认关（opt-in，检测走云端解析、消耗 credits）
    screenSenseEnabled: map.screenSenseEnabled === 'true',
    screenSenseHotkey: map.screenSenseHotkey || 'Alt+S',
    screenSenseContinuous: map.screenSenseContinuous !== 'false',
    screenSenseIntervalSec: Number(map.screenSenseIntervalSec) || 5,
    screenSenseEventDriven: map.screenSenseEventDriven !== 'false',
    screenSenseFallbackIntervalSec:
      map.screenSenseFallbackIntervalSec != null
        ? Math.min(60, Math.max(30, Number(map.screenSenseFallbackIntervalSec) || 45))
        : 45,
    screenSenseHybridV2: map.screenSenseHybridV2 !== 'false',
    // 排除名单空 = 不排除（不能像关键词那样回退默认词表）
    screenSenseExcludedApps: parseList(map.screenSenseExcludedApps),
    historyIncludedApps: parseList(map.historyIncludedApps),
    historyExcludedApps: parseHistoryAppList(map.historyExcludedApps),
    historyIncludedHosts: parseList(map.historyIncludedHosts)
      .map((value) => normalizeHistoryHost(value))
      .filter((value): value is string => value !== null),
    historyExcludedHosts: parseList(map.historyExcludedHosts)
      .map((value) => normalizeHistoryHost(value))
      .filter((value): value is string => value !== null),
    screenSenseKeepShots: map.screenSenseKeepShots === 'true',
    screenSenseRetentionDays: map.screenSenseRetentionDays != null ? Number(map.screenSenseRetentionDays) : 14,
    screenSensePopup: map.screenSensePopup !== 'false',
    screenSenseWorkLog: map.screenSenseWorkLog !== 'false',
    screenSenseVlmConfirm: map.screenSenseVlmConfirm === 'true',
    dailyReportTime: map.dailyReportTime ?? '',
    screenSenseCardHideSec:
      map.screenSenseCardHideSec != null ? Number(map.screenSenseCardHideSec) : 5,
    assistantAutoCloseSec: map.assistantAutoCloseSec != null ? Number(map.assistantAutoCloseSec) : 60,
    theme: map.theme === 'light' || map.theme === 'dark' ? map.theme : 'system',
    mcpEnabled: map.mcpEnabled === 'true',
    mcpPort: Number(map.mcpPort) || 38999,
    mcpToken: map.mcpToken ?? '',
    historyV2Enabled: map.historyV2Enabled === 'true',
    historyDerivedWorkEnabled: map.historyDerivedWorkEnabled === 'true',
    historyCaptureText: map.historyCaptureText === 'true'
  }
}

/** 逗号存储字符串 → 数组；空则返回空数组（无默认） */
function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseHistoryAppList(raw: string | undefined): HistoryAppSelection[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.flatMap((item): HistoryAppSelection[] => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      const bundleId = typeof value.bundleId === 'string' ? value.bundleId.trim() : ''
      if (!bundleId || seen.has(bundleId.toLowerCase())) return []
      seen.add(bundleId.toLowerCase())
      return [{
        bundleId,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : bundleId,
        path: typeof value.path === 'string' ? value.path.trim() : ''
      }]
    })
  } catch {
    return []
  }
}

export function saveSettings(patch: Partial<AppSettings>): void {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === 'historyIncludedHosts' || k === 'historyExcludedHosts') {
      const values = Array.isArray(v)
        ? v.map((item) => normalizeHistoryHost(item)).filter((item): item is string => item !== null)
        : []
      stmt.run(k, values.join(','))
      continue
    }
    if (k === 'historyExcludedApps') {
      const values = Array.isArray(v)
        ? v.flatMap((item): HistoryAppSelection[] => {
            if (!item || typeof item !== 'object') return []
            const value = item as unknown as Record<string, unknown>
            const bundleId = typeof value.bundleId === 'string' ? value.bundleId.trim() : ''
            if (!bundleId) return []
            return [{
              bundleId,
              name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : bundleId,
              path: typeof value.path === 'string' ? value.path.trim() : ''
            }]
          })
        : []
      const deduped = [...new Map(values.map((item) => [item.bundleId.toLowerCase(), item])).values()]
      stmt.run(k, JSON.stringify(deduped))
      continue
    }
    stmt.run(k, String(v))
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
  evidence_source?: string | null
  derived_by?: string | null
  segment_id?: string | null
  start_at?: string | null
  end_at?: string | null
  confidence?: number | null
  evidence_count?: number | null
  summary_hash?: string | null
  created_at: string
}

function rowToWorkRecord(r: WorkRecordRow): WorkRecord {
  const createdAt = r.created_at
  return {
    id: r.id,
    content: r.content,
    app: r.app,
    task: normalizeTaskLabel(r.task),
    source: r.evidence_source === 'accessibility' ? 'accessibility' : 'ocr',
    derivedBy: r.derived_by === 'history' ? 'history' : 'legacy',
    segmentId: r.segment_id ?? null,
    startAt: r.start_at ?? createdAt,
    endAt: r.end_at ?? createdAt,
    confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
    evidenceCount: Math.max(0, Math.trunc(Number(r.evidence_count) || 0)),
    summaryHash: r.summary_hash ?? null,
    createdAt
  }
}

function localDateTimeAtPrecise(value: string, fallback = localNow()): string {
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) return fallback
  const d = new Date(timestampMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function normalizeWorkTimestamp(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  // Existing callers use local YYYY-MM-DDTHH:mm values. History summaries use
  // UTC ISO values, which are converted once at the persistence boundary.
  return value.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(value)
    ? localDateTimeAtPrecise(value, fallback)
    : value.slice(0, 19)
}

function insertWorkRecord(rec: {
  id: string
  content: string
  app: string | null
  task: string | null
  source: WorkRecordSource
  derivedBy: 'history' | 'legacy'
  segmentId: string | null
  startAt: string
  endAt: string
  confidence: number
  evidenceCount: number
  summaryHash: string | null
  createdAt: string
}): WorkRecord {
  db.prepare(
    `INSERT INTO work_records (
      id, content, app, task, evidence_source, segment_id, start_at, end_at,
      confidence, evidence_count, summary_hash, derived_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.id,
    rec.content,
    rec.app,
    rec.task,
    rec.source,
    rec.segmentId,
    rec.startAt,
    rec.endAt,
    rec.confidence,
    rec.evidenceCount,
    rec.summaryHash,
    rec.derivedBy,
    rec.createdAt
  )
  db.prepare(
    'DELETE FROM work_records WHERE id NOT IN (SELECT id FROM work_records ORDER BY COALESCE(end_at, created_at) DESC LIMIT ?)'
  ).run(WORK_RECORDS_CAP)
  return rowToWorkRecord({
    id: rec.id,
    content: rec.content,
    app: rec.app,
    task: rec.task,
    evidence_source: rec.source,
    derived_by: rec.derivedBy,
    segment_id: rec.segmentId,
    start_at: rec.startAt,
    end_at: rec.endAt,
    confidence: rec.confidence,
    evidence_count: rec.evidenceCount,
    summary_hash: rec.summaryHash,
    created_at: rec.createdAt
  })
}

export function addWorkRecord(w: {
  content: string
  app: string | null
  task?: string | null
  source?: WorkRecordSource
  derivedBy?: 'legacy'
  startAt?: string
  endAt?: string
  confidence?: number
  evidenceCount?: number
  segmentId?: string | null
  summaryHash?: string | null
  createdAt?: string
}): WorkRecord {
  const createdAt = w.createdAt?.slice(0, 19) || localNow()
  const rec = {
    id: randomUUID(),
    content: w.content.slice(0, 200),
    app: w.app,
    task: normalizeTaskLabel(w.task),
    source: w.source ?? 'ocr',
    derivedBy: w.derivedBy ?? 'legacy' as const,
    segmentId: w.segmentId ?? null,
    startAt: normalizeWorkTimestamp(w.startAt, createdAt),
    endAt: normalizeWorkTimestamp(w.endAt, normalizeWorkTimestamp(w.startAt, createdAt)),
    confidence: Math.min(1, Math.max(0, Number(w.confidence) || 0.5)),
    evidenceCount: Math.max(0, Math.trunc(Number(w.evidenceCount) || 1)),
    summaryHash: w.summaryHash ?? null,
    createdAt
  }
  return insertWorkRecord(rec)
}

/** Upsert one History-derived record by segment; a changed summary updates in place. */
export function upsertHistoryWorkRecord(input: HistoryDerivedWorkRecordInput): WorkRecord {
  const fallback = localNow()
  const startAt = normalizeWorkTimestamp(input.startAt, fallback)
  const endAt = normalizeWorkTimestamp(input.endAt, startAt)
  const content = input.content.slice(0, 200)
  const app = input.app?.slice(0, 80) ?? null
  const task = normalizeTaskLabel(input.task)
  const confidence = Math.min(1, Math.max(0, Number(input.confidence) || 0))
  const evidenceCount = Math.max(0, Math.trunc(Number(input.evidenceCount) || 0))
  const existing = db.prepare(
    "SELECT * FROM work_records WHERE derived_by = 'history' AND segment_id = ? LIMIT 1"
  ).get(input.segmentId) as WorkRecordRow | undefined
  if (existing) {
    const unchanged =
      existing.content === content &&
      existing.app === app &&
      existing.task === task &&
      existing.start_at === startAt &&
      existing.end_at === endAt &&
      Number(existing.confidence) === confidence &&
      Number(existing.evidence_count) === evidenceCount &&
      existing.summary_hash === input.summaryHash
    if (!unchanged) {
      db.prepare(
        `UPDATE work_records
         SET content = ?, app = ?, task = ?, start_at = ?, end_at = ?,
             confidence = ?, evidence_count = ?, summary_hash = ?, created_at = ?
         WHERE id = ?`
      ).run(content, app, task, startAt, endAt, confidence, evidenceCount, input.summaryHash, endAt, existing.id)
    }
    return rowToWorkRecord({
      ...existing,
      content,
      app,
      task,
      start_at: startAt,
      end_at: endAt,
      confidence,
      evidence_count: evidenceCount,
      summary_hash: input.summaryHash,
      created_at: endAt
    })
  }

  return insertWorkRecord({
    id: `history-work-${input.segmentId}`,
    content,
    app,
    task,
    source: 'accessibility',
    derivedBy: 'history',
    segmentId: input.segmentId,
    startAt,
    endAt,
    confidence,
    evidenceCount,
    summaryHash: input.summaryHash,
    createdAt: endAt
  })
}

/** Remove only the current derived record; legacy OCR records are untouched. */
export function removeHistoryWorkRecord(segmentId: string): void {
  db.prepare("DELETE FROM work_records WHERE derived_by = 'history' AND segment_id = ?").run(segmentId)
}

/** Remove History-derived records for a set of segments and return actual row ids. */
export function removeHistoryWorkRecords(segmentIds: string[]): string[] {
  const ids = [...new Set(segmentIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (!ids.length) return []
  const select = db.prepare("SELECT id FROM work_records WHERE derived_by = 'history' AND segment_id = ?")
  const remove = db.prepare("DELETE FROM work_records WHERE derived_by = 'history' AND segment_id = ?")
  const deleted: string[] = []
  db.transaction((values: string[]) => {
    for (const segmentId of values) {
      const rows = select.all(segmentId) as { id: string }[]
      for (const row of rows) deleted.push(row.id)
      remove.run(segmentId)
    }
  })(ids)
  return deleted
}

/** 某天（YYYY-MM-DD）的工作记录，按时间正序。 */
export function listWorkRecords(day: string): WorkRecord[] {
  const rows = db
    .prepare('SELECT * FROM work_records WHERE COALESCE(start_at, created_at) LIKE ? ORDER BY COALESCE(start_at, created_at), created_at')
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

/** 日期范围内的应用时长（分析页近 7 天趋势用）。 */
export function appUsageRange(fromDay: string, toDay: string): (AppUsageEntry & { day: string })[] {
  return db
    .prepare('SELECT day, app, seconds FROM app_usage WHERE day >= ? AND day <= ? ORDER BY day')
    .all(fromDay, toDay) as (AppUsageEntry & { day: string })[]
}

// ---------- app_switches（前台应用切换事件；只存应用名与时刻，不存内容。注意力分析素材）----------

export function addAppSwitch(fromApp: string | null, toApp: string): void {
  // 秒级时间戳：同一分钟内多次切换需稳定排序，短停留判定也依赖亚分钟精度
  db.prepare('INSERT INTO app_switches (ts, from_app, to_app) VALUES (?, ?, ?)').run(
    localNowSec(),
    fromApp,
    toApp
  )
}

export function listAppSwitchesSince(sinceDay: string): AppSwitchRecord[] {
  return db
    .prepare(
      'SELECT ts, from_app AS fromApp, to_app AS toApp FROM app_switches WHERE ts >= ? ORDER BY ts'
    )
    .all(sinceDay) as AppSwitchRecord[]
}

// ---------- app_categories（应用生产力分类的用户覆盖；默认规则在 shared/attention.ts）----------

export function listAppCategoryOverrides(): AppCategoryOverride[] {
  return db.prepare('SELECT app, category FROM app_categories').all() as AppCategoryOverride[]
}

/** category 传 null 表示清除覆盖、回到默认规则。 */
export function setAppCategoryOverride(app: string, category: string | null): void {
  if (category === null) db.prepare('DELETE FROM app_categories WHERE app = ?').run(app)
  else
    db.prepare(
      'INSERT INTO app_categories (app, category) VALUES (?, ?) ON CONFLICT(app) DO UPDATE SET category = excluded.category'
    ).run(app, category)
}

// ---------- Hybrid History v2（只持久化聚合片段和脱敏 OCR 证据，不落盘原始事件） ----------

export function upsertActivitySegment(segment: ActivityHistorySegmentRecord): void {
  db.prepare(
    `INSERT INTO activity_segments (
      id, bucket_kind, bucket_start, bucket_end, first_event_at, last_event_at,
      event_count, meaningful_event_count, semantic_complete_count, semantic_partial_count,
      semantic_empty_count, ocr_evidence_count, trigger_reasons, summary, closed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      bucket_end = excluded.bucket_end,
      first_event_at = excluded.first_event_at,
      last_event_at = excluded.last_event_at,
      event_count = excluded.event_count,
      meaningful_event_count = excluded.meaningful_event_count,
      semantic_complete_count = excluded.semantic_complete_count,
      semantic_partial_count = excluded.semantic_partial_count,
      semantic_empty_count = excluded.semantic_empty_count,
      ocr_evidence_count = excluded.ocr_evidence_count,
      trigger_reasons = excluded.trigger_reasons,
      summary = excluded.summary,
      closed = excluded.closed,
      updated_at = excluded.updated_at
    WHERE activity_segments.bucket_end IS NOT excluded.bucket_end
      OR activity_segments.first_event_at IS NOT excluded.first_event_at
      OR activity_segments.last_event_at IS NOT excluded.last_event_at
      OR activity_segments.event_count IS NOT excluded.event_count
      OR activity_segments.meaningful_event_count IS NOT excluded.meaningful_event_count
      OR activity_segments.semantic_complete_count IS NOT excluded.semantic_complete_count
      OR activity_segments.semantic_partial_count IS NOT excluded.semantic_partial_count
      OR activity_segments.semantic_empty_count IS NOT excluded.semantic_empty_count
      OR activity_segments.ocr_evidence_count IS NOT excluded.ocr_evidence_count
      OR activity_segments.trigger_reasons IS NOT excluded.trigger_reasons
      OR activity_segments.summary IS NOT excluded.summary
      OR activity_segments.closed IS NOT excluded.closed`
  ).run(
    segment.id,
    segment.bucketKind,
    segment.bucketStart,
    segment.bucketEnd,
    segment.firstEventAt,
    segment.lastEventAt,
    segment.eventCount,
    segment.meaningfulEventCount,
    segment.semanticCompleteCount,
    segment.semanticPartialCount,
    segment.semanticEmptyCount,
    segment.ocrEvidenceCount,
    JSON.stringify(segment.triggerReasons),
    segment.summary.slice(0, 1000),
    segment.closed ? 1 : 0,
    segment.createdAt,
    segment.updatedAt
  )
}

export function addOcrEvidence(evidence: OcrEvidenceRecord): void {
  db.prepare(
    `INSERT INTO ocr_evidence (
      id, event_id, segment_id, occurred_at, app_name, bundle_id, window_title,
      semantic_score, trigger_reason, redaction_hits, redacted_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    evidence.id,
    evidence.eventId,
    evidence.segmentId,
    evidence.occurredAt,
    evidence.appName,
    evidence.bundleId,
    evidence.windowTitle,
    Math.max(0, Math.min(100, Math.round(evidence.semanticScore))),
    evidence.triggerReason,
    JSON.stringify(evidence.redactionHits),
    evidence.redactedText.slice(0, 20_000),
    evidence.createdAt
  )
}

export function listActivitySegments(limit = 40): ActivityHistorySegmentRecord[] {
  const rows = db
    .prepare('SELECT * FROM activity_segments ORDER BY bucket_start DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    bucketKind: String(row.bucket_kind) as '10m' | '6h',
    bucketStart: String(row.bucket_start),
    bucketEnd: String(row.bucket_end),
    firstEventAt: String(row.first_event_at),
    lastEventAt: String(row.last_event_at),
    eventCount: Number(row.event_count),
    meaningfulEventCount: Number(row.meaningful_event_count),
    semanticCompleteCount: Number(row.semantic_complete_count),
    semanticPartialCount: Number(row.semantic_partial_count),
    semanticEmptyCount: Number(row.semantic_empty_count),
    ocrEvidenceCount: Number(row.ocr_evidence_count),
    triggerReasons: JSON.parse(String(row.trigger_reasons || '[]')) as string[],
    summary: String(row.summary),
    closed: Number(row.closed) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }))
}

/** Aggregate legacy segments for a bounded rollout comparison window. */
export function listActivitySegmentsSince(fromIso: string, toIso: string): ActivityHistorySegmentRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM activity_segments WHERE bucket_kind = '10m' AND bucket_end > ? AND bucket_start < ? ORDER BY bucket_start"
    )
    .all(fromIso, toIso) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    bucketKind: String(row.bucket_kind) as '10m' | '6h',
    bucketStart: String(row.bucket_start),
    bucketEnd: String(row.bucket_end),
    firstEventAt: String(row.first_event_at),
    lastEventAt: String(row.last_event_at),
    eventCount: Number(row.event_count),
    meaningfulEventCount: Number(row.meaningful_event_count),
    semanticCompleteCount: Number(row.semantic_complete_count),
    semanticPartialCount: Number(row.semantic_partial_count),
    semanticEmptyCount: Number(row.semantic_empty_count),
    ocrEvidenceCount: Number(row.ocr_evidence_count),
    triggerReasons: JSON.parse(String(row.trigger_reasons || '[]')) as string[],
    summary: String(row.summary),
    closed: Number(row.closed) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }))
}

export function listOcrEvidence(limit = 40): OcrEvidenceRecord[] {
  const rows = db
    .prepare('SELECT * FROM ocr_evidence ORDER BY occurred_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    eventId: row.event_id == null ? null : String(row.event_id),
    segmentId: row.segment_id == null ? null : String(row.segment_id),
    occurredAt: String(row.occurred_at),
    appName: row.app_name == null ? null : String(row.app_name),
    bundleId: row.bundle_id == null ? null : String(row.bundle_id),
    windowTitle: row.window_title == null ? null : String(row.window_title),
    semanticScore: Number(row.semantic_score),
    triggerReason: String(row.trigger_reason),
    redactionHits: JSON.parse(String(row.redaction_hits || '[]')) as string[],
    redactedText: String(row.redacted_text),
    createdAt: String(row.created_at)
  }))
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
  // 检测卡「备注」反馈：直接进解析/助手提示词，判断归属与取舍时优先遵循用户的人工纠错
  const notes = listRecentDetectionNotes()
  if (notes.length)
    parts.push(
      `【近期纠错备注】（用户对自动检测的人工反馈，同类判断优先遵循）\n${notes
        .map((n) => `- 「${n.title}」：${n.note}`)
        .join('\n')}`
    )
  return parts.join('\n')
}

/**
 * 待确认检测自动过期：会议类过点 1 天（会已开完，确认无意义）、其余 7 天未处理（基本是噪声）
 * → 自动转忽略。只改状态不删数据。启动时与每次拉待确认列表前各清一遍。
 */
export function cleanupStaleDetections(): void {
  const at = (ms: number): string => {
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }
  db.prepare(
    "UPDATE detections SET status='dismissed' WHERE status='new' AND ((time_iso IS NOT NULL AND deadline=0 AND time_iso < ?) OR created_at < ?)"
  ).run(at(Date.now() - 86_400_000), at(Date.now() - 7 * 86_400_000))
  // 屏幕 OCR 原文是高敏临时证据；48 小时后只保留标题、时间、应用和处理状态。
  db.prepare("UPDATE detections SET source_text='' WHERE source_text != '' AND created_at < ?").run(
    at(Date.now() - 48 * 60 * 60 * 1000)
  )
}

// ---------- detection_notes（检测卡「备注」：用户对检测结果的人工反馈，个性化学习素材）----------

export function addDetectionNote(detectionId: string | null, title: string, note: string): void {
  db.prepare(
    'INSERT INTO detection_notes (id, detection_id, title, note, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), detectionId, title.slice(0, 120), note.slice(0, 200), localNow())
}

/** 近期备注（默认 14 天内最多 8 条，新的在前）——注入提示词用，条数刻意收紧防噪声。 */
export function listRecentDetectionNotes(
  days = 14,
  limit = 8
): { title: string; note: string }[] {
  const since = dayKey(new Date(Date.now() - days * 86_400_000))
  return db
    .prepare(
      'SELECT title, note FROM detection_notes WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(since, limit) as { title: string; note: string }[]
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
  const n = normalizeTaskLabel(name, 60)
  if (!n) return
  db.prepare(
    'INSERT INTO focus_tasks (name, hidden, custom, created_at) VALUES (?, 0, 1, ?) ON CONFLICT(name) DO UPDATE SET hidden = 0'
  ).run(n, localNow())
}

/** 「删除」一个任务：标记隐藏（不进展示、不进模型候选）。 */
export function hideFocusTask(name: string): void {
  const n = normalizeTaskLabel(name, 60)
  if (!n) return
  db.prepare(
    'INSERT INTO focus_tasks (name, hidden, custom, created_at) VALUES (?, 1, 0, ?) ON CONFLICT(name) DO UPDATE SET hidden = 1'
  ).run(n, localNow())
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
        'SELECT DISTINCT task FROM work_records WHERE task IS NOT NULL AND COALESCE(start_at, created_at) >= ? ORDER BY COALESCE(start_at, created_at) DESC'
      )
      .all(sinceKey) as { task: string }[]
  ).map((r) => r.task)
  const prefs = listFocusTaskPrefs()
  const hidden = new Set(prefs.filter((p) => p.hidden).map((p) => normalizeTaskKey(p.name)))
  const custom = prefs.filter((p) => p.custom && !p.hidden).map((p) => p.name)
  // 按归一键去重：同一任务的空格/大小写变体只给模型一个候选，否则列表被近重复挤满、
  // 模型也更容易在变体间摇摆（任务专注拆条的源头）
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of [...custom, ...derived]) {
    const key = normalizeTaskKey(n)
    if (hidden.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(n)
    if (out.length >= 12) break
  }
  return out
}

/** 历史出现过的全部前台 App 名（app_usage + work_records），用于拒绝「裸 App 名」任务。 */
export function listKnownAppNames(): string[] {
  const names = new Set<string>()
  for (const row of db.prepare('SELECT DISTINCT app FROM app_usage').all() as { app: string }[]) names.add(row.app)
  for (const row of db.prepare('SELECT DISTINCT app FROM work_records WHERE app IS NOT NULL').all() as { app: string }[])
    names.add(row.app)
  return [...names]
}

/** 近 N 天工作记录（供个人记忆归纳/活动时间线）。 */
export function listWorkRecordsSince(sinceDay: string): WorkRecord[] {
  const rows = db
    .prepare('SELECT * FROM work_records WHERE COALESCE(start_at, created_at) >= ? ORDER BY COALESCE(start_at, created_at), created_at')
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
        .prepare('SELECT * FROM work_records WHERE COALESCE(start_at, created_at) >= ? AND COALESCE(start_at, created_at) <= ? ORDER BY COALESCE(start_at, created_at), created_at')
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
    'DELETE FROM tasks; DELETE FROM sources; DELETE FROM detections; DELETE FROM profile; DELETE FROM work_records; DELETE FROM app_usage; DELETE FROM reports; DELETE FROM personal_memory; DELETE FROM focus_tasks; DELETE FROM app_switches; DELETE FROM app_categories; DELETE FROM detection_notes; DELETE FROM activity_segments; DELETE FROM ocr_evidence; DELETE FROM history_summaries;'
  )
  // SQLite 删除只标记页空闲，原文字节仍留在文件里；清数据要真正回收
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
}

/** 清空「记忆」：来源历史(sources+FTS)、屏幕识别历史(detections)、工作记录与个人画像。保留任务/档案/日报。 */
export function wipeMemory(): void {
  db.exec(
    'DELETE FROM sources; DELETE FROM sources_fts; DELETE FROM detections; DELETE FROM work_records; DELETE FROM personal_memory; DELETE FROM focus_tasks; DELETE FROM app_switches; DELETE FROM detection_notes; DELETE FROM activity_segments; DELETE FROM ocr_evidence; DELETE FROM history_summaries;'
  )
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
}
