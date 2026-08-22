import type Database from 'better-sqlite3'

export type HistorySummaryLevel = '10m' | '6h'
export type HistorySummaryStatus = 'pending' | 'ready' | 'failed'
export type HistorySummaryModelStatus = 'idle' | 'ready' | 'failed'

/** Durable state for both 10-minute summaries and 6-hour rollups. */
export interface HistorySummaryRecord {
  id: string
  level: HistorySummaryLevel
  bucketStart: string
  bucketEnd: string
  sourceSegmentIds: string[]
  sourceHash: string
  status: HistorySummaryStatus
  summaryText: string | null
  summaryJson: string | null
  modelStatus: HistorySummaryModelStatus
  attemptCount: number
  nextRetryAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface HistorySummaryIndex {
  upsert(record: HistorySummaryRecord): void
  remove(id: string): void
  get(id: string): HistorySummaryRecord | null
  list(level?: HistorySummaryLevel): HistorySummaryRecord[]
  count(level?: HistorySummaryLevel): number
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, 128)
}

function rowToRecord(row: Record<string, unknown>): HistorySummaryRecord {
  let sourceSegmentIds: string[] = []
  try {
    sourceSegmentIds = stringArray(JSON.parse(String(row.source_segment_ids ?? '[]')))
  } catch {
    sourceSegmentIds = []
  }
  const level = String(row.level) === '6h' ? '6h' : '10m'
  const status = String(row.status)
  const modelStatus = String(row.model_status)
  return {
    id: String(row.id),
    level,
    bucketStart: String(row.bucket_start),
    bucketEnd: String(row.bucket_end),
    sourceSegmentIds,
    sourceHash: String(row.source_hash ?? ''),
    status: status === 'failed' ? 'failed' : status === 'pending' ? 'pending' : 'ready',
    summaryText: row.summary_text == null ? null : String(row.summary_text),
    summaryJson: row.summary_json == null ? null : String(row.summary_json),
    modelStatus: modelStatus === 'ready' ? 'ready' : modelStatus === 'failed' ? 'failed' : 'idle',
    attemptCount: Math.max(0, Number(row.attempt_count) || 0),
    nextRetryAt: row.next_retry_at == null ? null : String(row.next_retry_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

export function createSqliteHistorySummaryIndex(db: Database.Database): HistorySummaryIndex {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_summaries (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      bucket_start TEXT NOT NULL,
      bucket_end TEXT NOT NULL,
      source_segment_ids TEXT NOT NULL DEFAULT '[]',
      source_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      summary_text TEXT,
      summary_json TEXT,
      model_status TEXT NOT NULL DEFAULT 'idle',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_summaries_bucket
      ON history_summaries(level, bucket_start);
  `)

  const upsert = db.prepare(`
    INSERT INTO history_summaries (
      id, level, bucket_start, bucket_end, source_segment_ids, source_hash,
      status, summary_text, summary_json, model_status, attempt_count,
      next_retry_at, last_error, created_at, updated_at
    ) VALUES (
      @id, @level, @bucketStart, @bucketEnd, @sourceSegmentIds, @sourceHash,
      @status, @summaryText, @summaryJson, @modelStatus, @attemptCount,
      @nextRetryAt, @lastError, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      level = excluded.level,
      bucket_start = excluded.bucket_start,
      bucket_end = excluded.bucket_end,
      source_segment_ids = excluded.source_segment_ids,
      source_hash = excluded.source_hash,
      status = excluded.status,
      summary_text = excluded.summary_text,
      summary_json = excluded.summary_json,
      model_status = excluded.model_status,
      attempt_count = excluded.attempt_count,
      next_retry_at = excluded.next_retry_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `)

  return {
    upsert(record): void {
      upsert.run({
        ...record,
        sourceSegmentIds: JSON.stringify(record.sourceSegmentIds.slice(0, 128))
      })
    },
    remove(id): void {
      db.prepare('DELETE FROM history_summaries WHERE id = ?').run(id)
    },
    get(id): HistorySummaryRecord | null {
      const row = db.prepare('SELECT * FROM history_summaries WHERE id = ?').get(id) as Record<string, unknown> | undefined
      return row ? rowToRecord(row) : null
    },
    list(level?): HistorySummaryRecord[] {
      const rows = level
        ? (db.prepare('SELECT * FROM history_summaries WHERE level = ? ORDER BY bucket_start').all(level) as Record<string, unknown>[])
        : (db.prepare('SELECT * FROM history_summaries ORDER BY bucket_start').all() as Record<string, unknown>[])
      return rows.map(rowToRecord)
    },
    count(level?): number {
      const row = level
        ? (db.prepare('SELECT count(*) AS n FROM history_summaries WHERE level = ?').get(level) as { n: number })
        : (db.prepare('SELECT count(*) AS n FROM history_summaries').get() as { n: number })
      return Number(row.n)
    }
  }
}
