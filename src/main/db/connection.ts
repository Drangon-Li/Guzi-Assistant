// SQLite 连接与建表：唯一持有 Database 句柄的地方。其余 db/* 模块通过 getDb() 取句柄，
// 不各自开库，避免同一个文件被打开两次。
// 与 detections.ts 互相引用：initDb() 在启动时做一次 48 小时 OCR 原文清理。
// 这个环在 ESM 下是安全的——两边都没有依赖对方的顶层副作用，detections 只在函数体里调 getDb()，
// 而这里只在 initDb() 运行时（模块图早已求值完毕）才调它。
import { cleanupStaleDetections } from './detections.ts'
// 与 ../plugins/index.ts 互相引用（那边要 getDb，这边要建插件表）。和 detections 一样，
// 两边都只在函数体里用对方，模块图求值时互不依赖，ESM 下安全。
import { initEnabledPluginTables } from '../plugins/index.ts'
import { migrateTaskExtras, migrateTaskReminders, migrateWorkRecords, scrubInvalidTaskNames } from '../db-migrations.ts'
import { createSqliteHistorySegmentIndex } from '../history/segment-index.ts'
import type { HistorySegmentIndex } from '../history/segment-index.ts'
import { createSqliteHistorySummaryIndex } from '../history/summary-index.ts'
import type { HistorySummaryIndex } from '../history/summary-index.ts'
import { dayKey } from '@shared/work-report'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

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
    CREATE TABLE IF NOT EXISTS chat_messages (
      seq INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
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
  // 老库迁移：tasks 加提醒三列（纯加列，旧客户端 SELECT * 忽略即可）
  migrateTaskReminders(db)
  migrateTaskExtras(db)
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

  // 已启用插件的表。核心表全部建完之后才轮到插件——插件可以引用核心表，反过来不行。
  initEnabledPluginTables(db)
}

export function getHistorySegmentIndex(): HistorySegmentIndex {
  if (!historySegmentIndex) throw new Error('database has not been initialized')
  return historySegmentIndex
}

export function getHistorySummaryIndex(): HistorySummaryIndex {
  if (!historySummaryIndex) throw new Error('database has not been initialized')
  return historySummaryIndex
}

export function localDateTimeAt(timestampMs: number): string {
  const d = new Date(timestampMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 取 Database 句柄。initDb() 之前调用会直接抛，问题停在这里而不是散成一堆 undefined。 */
export function getDb(): Database.Database {
  if (!db) throw new Error('database has not been initialized')
  return db
}

/** FTS5/trigram 是否可用；不可用时来源检索退化为 LIKE，索引写入变 no-op。 */
export function isFtsReady(): boolean {
  return ftsReady
}
