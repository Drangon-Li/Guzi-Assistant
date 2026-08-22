import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateWorkRecords } from '../src/main/db-migrations.ts'

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
  console.log('\nHistory migration checks passed')
} finally {
  db.close()
}
