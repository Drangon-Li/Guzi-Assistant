import type Database from 'better-sqlite3'
import { isAppNameTask, isGenericFocusTask } from '../shared/work-report.ts'

/**
 * Apply additive work_records migrations. Keeping this separate from Electron
 * startup makes old-library upgrades independently testable and repeatable.
 */
export function migrateWorkRecords(database: Database.Database): void {
  const columns = (database.prepare('PRAGMA table_info(work_records)').all() as { name: string }[]).map(
    (column) => column.name
  )
  if (!columns.includes('task')) database.exec('ALTER TABLE work_records ADD COLUMN task TEXT')
  if (!columns.includes('evidence_source'))
    database.exec("ALTER TABLE work_records ADD COLUMN evidence_source TEXT NOT NULL DEFAULT 'ocr'")
  if (!columns.includes('segment_id')) database.exec('ALTER TABLE work_records ADD COLUMN segment_id TEXT')
  if (!columns.includes('start_at')) database.exec('ALTER TABLE work_records ADD COLUMN start_at TEXT')
  if (!columns.includes('end_at')) database.exec('ALTER TABLE work_records ADD COLUMN end_at TEXT')
  if (!columns.includes('confidence')) database.exec('ALTER TABLE work_records ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5')
  if (!columns.includes('evidence_count')) database.exec('ALTER TABLE work_records ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1')
  if (!columns.includes('summary_hash')) database.exec('ALTER TABLE work_records ADD COLUMN summary_hash TEXT')
  if (!columns.includes('derived_by')) database.exec("ALTER TABLE work_records ADD COLUMN derived_by TEXT NOT NULL DEFAULT 'legacy'")
  database.exec(`
    UPDATE work_records
    SET start_at = COALESCE(start_at, created_at),
        end_at = COALESCE(end_at, created_at),
        confidence = COALESCE(confidence, 0.5),
        evidence_count = COALESCE(evidence_count, 1),
        derived_by = COALESCE(NULLIF(derived_by, ''), 'legacy')
    WHERE start_at IS NULL OR end_at IS NULL OR confidence IS NULL OR evidence_count IS NULL OR derived_by IS NULL OR derived_by = '';
    CREATE INDEX IF NOT EXISTS idx_work_records_start ON work_records(start_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_records_summary_hash ON work_records(summary_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_records_history_segment
      ON work_records(segment_id)
      WHERE derived_by = 'history' AND segment_id IS NOT NULL;
  `)
}

/**
 * 老数据清理：把「裸 App/产品名」（如 谷子助手、微信 (窗口)）和「随心输入」类泛化名的
 * task 标签置空。这些标签来自早期归类逻辑（含把窗口标题当任务名的本地摘要），
 * 置空后不再进入任务专注统计，也不再作为模型候选任务名污染后续归类。
 */
export function scrubInvalidTaskNames(database: Database.Database): void {
  const apps = new Set<string>()
  for (const row of database.prepare('SELECT DISTINCT app FROM app_usage').all() as { app: string }[]) apps.add(row.app)
  for (const row of database
    .prepare('SELECT DISTINCT app FROM work_records WHERE app IS NOT NULL')
    .all() as { app: string }[])
    apps.add(row.app)
  const knownApps = [...apps]
  const rows = database.prepare('SELECT id, task FROM work_records WHERE task IS NOT NULL').all() as {
    id: string
    task: string
  }[]
  const targets = rows
    .filter(
      (row) =>
        isGenericFocusTask(row.task) ||
        isAppNameTask(row.task, knownApps) ||
        /[(（]窗口[)）]\s*$/.test(row.task) // 「微信 (窗口)」这类窗口标题残片
    )
    .map((row) => row.id)
  if (!targets.length) return
  const clear = database.prepare('UPDATE work_records SET task = NULL WHERE id = ?')
  database.transaction((ids: string[]) => {
    for (const id of ids) clear.run(id)
  })(targets)
}
