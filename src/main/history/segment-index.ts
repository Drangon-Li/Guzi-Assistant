import type Database from 'better-sqlite3'

export interface HistorySegmentMetadata {
  id: string
  bucketStart: string
  bucketEnd: string
  eventsPath: string
  eventCount: number
  meaningfulEventCount: number
  suppressedEventCount: number
  summaryStatus: 'pending' | 'ready' | 'failed'
  summaryText: string | null
  summaryJson: string | null
  retentionExpiresAt: string
  createdAt: string
  updatedAt: string
}

export interface HistorySegmentIndex {
  upsert(metadata: HistorySegmentMetadata): void
  remove(id: string): void
  get(id: string): HistorySegmentMetadata | null
  list(): HistorySegmentMetadata[]
  count(): number
}

function rowToMetadata(row: Record<string, unknown>): HistorySegmentMetadata {
  return {
    id: String(row.id),
    bucketStart: String(row.bucket_start),
    bucketEnd: String(row.bucket_end),
    eventsPath: String(row.events_path),
    eventCount: Number(row.event_count),
    meaningfulEventCount: Number(row.meaningful_event_count),
    suppressedEventCount: Number(row.suppressed_event_count),
    summaryStatus: String(row.summary_status) as HistorySegmentMetadata['summaryStatus'],
    summaryText: row.summary_text == null ? null : String(row.summary_text),
    summaryJson: row.summary_json == null ? null : String(row.summary_json),
    retentionExpiresAt: String(row.retention_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

export function createSqliteHistorySegmentIndex(db: Database.Database): HistorySegmentIndex {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_segments (
      id TEXT PRIMARY KEY,
      bucket_start TEXT NOT NULL,
      bucket_end TEXT NOT NULL,
      events_path TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      meaningful_event_count INTEGER NOT NULL DEFAULT 0,
      suppressed_event_count INTEGER NOT NULL DEFAULT 0,
      summary_status TEXT NOT NULL DEFAULT 'pending',
      summary_text TEXT,
      summary_json TEXT,
      retention_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_segments_bucket ON history_segments(bucket_start);
  `)
  const upsert = db.prepare(`
    INSERT INTO history_segments (
      id, bucket_start, bucket_end, events_path, event_count, meaningful_event_count,
      suppressed_event_count, summary_status, summary_text, summary_json,
      retention_expires_at, created_at, updated_at
    ) VALUES (@id, @bucketStart, @bucketEnd, @eventsPath, @eventCount, @meaningfulEventCount,
      @suppressedEventCount, @summaryStatus, @summaryText, @summaryJson,
      @retentionExpiresAt, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      bucket_start = excluded.bucket_start,
      bucket_end = excluded.bucket_end,
      events_path = excluded.events_path,
      event_count = excluded.event_count,
      meaningful_event_count = excluded.meaningful_event_count,
      suppressed_event_count = excluded.suppressed_event_count,
      summary_status = excluded.summary_status,
      summary_text = excluded.summary_text,
      summary_json = excluded.summary_json,
      retention_expires_at = excluded.retention_expires_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `)
  return {
    upsert(metadata): void {
      upsert.run(metadata)
    },
    remove(id): void {
      db.prepare('DELETE FROM history_segments WHERE id = ?').run(id)
    },
    get(id): HistorySegmentMetadata | null {
      const row = db.prepare('SELECT * FROM history_segments WHERE id = ?').get(id) as Record<string, unknown> | undefined
      return row ? rowToMetadata(row) : null
    },
    list(): HistorySegmentMetadata[] {
      const rows = db.prepare('SELECT * FROM history_segments ORDER BY bucket_start').all() as Record<string, unknown>[]
      return rows.map(rowToMetadata)
    },
    count(): number {
      return Number((db.prepare('SELECT count(*) AS n FROM history_segments').get() as { n: number }).n)
    }
  }
}
