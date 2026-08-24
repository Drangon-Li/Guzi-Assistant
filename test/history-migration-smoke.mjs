import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTaskReminders, migrateWorkRecords, scrubInvalidTaskNames } from '../src/main/db-migrations.ts'

const db = new Database(':memory:')
try {
  db.exec(`
    CREATE TABLE work_records (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      app TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO work_records (id, content, app, created_at)
      VALUES ('legacy-1', '旧 OCR 记录', 'Preview', '2026-08-22T10:00:00');
  `)

  migrateWorkRecords(db)
  const columns = new Set(db.prepare('PRAGMA table_info(work_records)').all().map((row) => row.name))
  for (const name of ['task', 'evidence_source', 'segment_id', 'start_at', 'end_at', 'confidence', 'evidence_count', 'summary_hash', 'derived_by']) {
    assert.ok(columns.has(name), `missing migrated column: ${name}`)
  }
  const legacy = db.prepare('SELECT * FROM work_records WHERE id = ?').get('legacy-1')
  assert.equal(legacy.derived_by, 'legacy')
  assert.equal(legacy.evidence_source, 'ocr')
  assert.equal(legacy.start_at, legacy.created_at)
  assert.equal(legacy.end_at, legacy.created_at)

  db.prepare(`
    INSERT INTO work_records (
      id, content, app, segment_id, start_at, end_at, confidence,
      evidence_count, summary_hash, derived_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'history', ?)
  `).run(
    'history-1', 'History 摘要', 'Code', 'segment-1',
    '2026-08-22T10:00:00', '2026-08-22T10:10:00', 0.8, 3, 'hash-1', '2026-08-22T10:10:00'
  )
  assert.throws(() => db.prepare(`
    INSERT INTO work_records (
      id, content, app, segment_id, start_at, end_at, confidence,
      evidence_count, summary_hash, derived_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'history', ?)
  `).run(
    'history-duplicate', 'History 摘要', 'Code', 'segment-1',
    '2026-08-22T10:00:00', '2026-08-22T10:10:00', 0.8, 3, 'hash-1', '2026-08-22T10:10:00'
  ))

  migrateWorkRecords(db)
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_records').get().n, 2)
  console.log('✓ old work_records schema migrates additively and preserves legacy rows')
  console.log('✓ History segment uniqueness and repeated migration are stable')

  // ---- migrateTaskReminders：tasks 加提醒三列，纯加列且可重复执行 ----
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      belongs_to_user TEXT NOT NULL,
      status TEXT NOT NULL,
      start_time TEXT,
      due_time TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO tasks (id, title, belongs_to_user, status, due_time, created_at)
      VALUES ('old-1', '旧任务', 'yes', 'scheduled', '2026-08-25T10:00', '2026-08-22T10:00:00');
  `)
  migrateTaskReminders(db)
  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name))
  for (const name of ['remind_offset_min', 'reminded_at', 'snoozed_until'])
    assert.ok(taskColumns.has(name), `missing reminder column: ${name}`)
  const oldTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('old-1')
  assert.equal(oldTask.remind_offset_min, null, '旧任务默认跟随全局提前量')
  assert.equal(oldTask.reminded_at, null)
  assert.equal(oldTask.snoozed_until, null)
  assert.equal(oldTask.title, '旧任务', '加列不动既有数据')
  migrateTaskReminders(db) // 幂等：重复执行不报错、不丢数据
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1)
  console.log('✓ tasks 提醒列加列迁移可重复执行且保留旧行')

  // ---- scrubInvalidTaskNames：裸 App 名/泛化名/窗口标题残片的 task 置空 ----
  db.exec(`CREATE TABLE app_usage (app TEXT, day TEXT, seconds INTEGER)`)
  db.prepare(`INSERT INTO app_usage (app, day, seconds) VALUES ('微信', '2026-08-23', 100)`).run()
  const insert = db.prepare(`INSERT INTO work_records (id, content, app, task, created_at) VALUES (?, ?, ?, ?, '2026-08-23T10:00:00')`)
  insert.run('scrub-self', 'x', 'ChatGPT', '谷子助手') // 自身产品名
  insert.run('scrub-app', 'x', 'Code', '微信') // 已知 App 名
  insert.run('scrub-window', 'x', 'Code', '微信 (窗口)') // 窗口标题残片
  insert.run('scrub-generic', 'x', 'Code', '随心输入') // 泛化名
  insert.run('keep-legit', 'x', 'Code', '开发谷子助手') // 带动作的合法任务名
  insert.run('keep-normal', 'x', 'Code', '论文研读与标注')
  scrubInvalidTaskNames(db)
  const taskOf = (id) => db.prepare('SELECT task FROM work_records WHERE id = ?').get(id).task
  assert.equal(taskOf('scrub-self'), null)
  assert.equal(taskOf('scrub-app'), null)
  assert.equal(taskOf('scrub-window'), null)
  assert.equal(taskOf('scrub-generic'), null)
  assert.equal(taskOf('keep-legit'), '开发谷子助手')
  assert.equal(taskOf('keep-normal'), '论文研读与标注')
  scrubInvalidTaskNames(db) // 幂等：重复执行无副作用
  assert.equal(taskOf('keep-legit'), '开发谷子助手')
  console.log('✓ 裸 App 名/泛化名/窗口标题残片的 task 标签被置空且幂等')
  console.log('\nHistory migration checks passed')
} finally {
  db.close()
}
