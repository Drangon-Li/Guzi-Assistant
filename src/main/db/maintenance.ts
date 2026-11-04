// 跨表维护操作：按时间范围导出、清空全部数据、清空「记忆」。
// 直接走裸 SQL，不反向依赖各领域模块，避免形成环。
import { getDb } from './connection.ts'
import { listWorkRecordsBetween } from './work-records.ts'
import { localNow } from '@shared/parsing'
import { pluginSettingKey } from './plugins.ts'

/** 数据导出：某时间范围（含端点，日键比较）内的工作记录/日报/应用时长/检测。 */
export function exportRange(fromDay: string, toDay: string): Record<string, unknown> {
  const hi = `${toDay}￿`
  return {
    exportedAt: localNow(),
    range: { from: fromDay, to: toDay },
    workRecords: listWorkRecordsBetween(fromDay, hi),
    reports: getDb()
      .prepare('SELECT id, day, type, title, content, created_at AS createdAt FROM reports WHERE day >= ? AND day <= ? ORDER BY day')
      .all(fromDay, toDay),
    appUsage: getDb()
      .prepare('SELECT day, app, seconds FROM app_usage WHERE day >= ? AND day <= ? ORDER BY day, seconds DESC')
      .all(fromDay, toDay),
    detections: getDb()
      .prepare(
        'SELECT id, title, time_iso AS timeIso, status, app, created_at AS createdAt FROM detections WHERE created_at >= ? AND created_at <= ? ORDER BY created_at'
      )
      .all(fromDay, hi)
  }
}

export function wipeAll(): void {
  const db = getDb()
  // FTS shadow 表由虚表管理，逐个 DELETE 会破坏索引；停用插件的内容表也要覆盖。
  const tables = db.prepare(`
    SELECT name FROM pragma_table_list
    WHERE schema = 'main' AND type IN ('table', 'virtual')
      AND name NOT LIKE 'sqlite_%' AND name != 'settings'
  `).all() as { name: string }[]
  db.transaction(() => {
    for (const { name } of tables) db.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`)
    if (tables.some(({ name }) => name === 'sources_fts'))
      db.exec("INSERT INTO sources_fts(sources_fts) VALUES('optimize')")
    db.prepare('DELETE FROM settings WHERE key = ?').run(pluginSettingKey('pomodoro', 'continuation'))
  })()
  // SQLite 删除只标记页空闲，原文字节仍留在文件里；清数据要真正回收
  db.exec('VACUUM')
  db.pragma('wal_checkpoint(TRUNCATE)')
}

/** 清空「记忆」：来源历史(sources+FTS)、屏幕识别历史(detections)、工作记录与个人画像。保留任务/档案/日报。 */
export function wipeMemory(): void {
  getDb().exec(
    'DELETE FROM sources; DELETE FROM sources_fts; DELETE FROM detections; DELETE FROM work_records; DELETE FROM personal_memory; DELETE FROM focus_tasks; DELETE FROM detection_notes; DELETE FROM activity_segments; DELETE FROM ocr_evidence; DELETE FROM history_summaries;'
  )
  getDb().pragma('wal_checkpoint(TRUNCATE)')
  getDb().exec('VACUUM')
}
