// sources：捕获来源原文 + FTS5 全文索引（trigram 不可用时退化为 LIKE）。
import { getDb, isFtsReady } from './connection.ts'
import { buildFtsQuery } from '@shared/fts-query'
import { localNow } from '@shared/parsing'
import type { MemoryHit, SourceRecord, SourceType } from '@shared/types'
import { randomUUID } from 'crypto'

function indexSourceFts(id: string, excerpt: string, content: string | null): void {
  if (!isFtsReady()) return
  getDb().prepare('INSERT INTO sources_fts (source_id, body) VALUES (?, ?)').run(
    id,
    `${excerpt}\n${content ?? ''}`
  )
}
function unindexSourceFts(id: string): void {
  if (!isFtsReady()) return
  getDb().prepare('DELETE FROM sources_fts WHERE source_id = ?').run(id)
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
  getDb().prepare(
    'INSERT INTO sources (id, type, excerpt, content, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(rec.id, rec.type, rec.excerpt, rec.content, rec.filePath, rec.createdAt)
  indexSourceFts(rec.id, rec.excerpt, rec.content) // #52 入记忆检索索引
  return rec
}

export function getSource(id: string): SourceRecord | null {
  const row = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined
  return row ? rowToSource(row) : null
}

/** 删除来源原文，保留任务（文档第 8 节：来源可删除） */
export function deleteSourceContent(id: string): void {
  getDb().prepare(
    "UPDATE sources SET content = NULL, file_path = NULL, excerpt = '[来源已删除]', deleted = 1 WHERE id = ?"
  ).run(id)
  unindexSourceFts(id) // 原文删了就不该再被搜到
}

/** 整行删除：解析失败时清理孤儿来源，避免无任务引用的原文滞留 */
export function deleteSourceRow(id: string): void {
  getDb().prepare('DELETE FROM sources WHERE id = ?').run(id)
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
  if (isFtsReady() && match && compact.length >= 3) {
    try {
      rows = getDb()
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
    rows = getDb()
      .prepare(
        `SELECT id, substr(IFNULL(content, excerpt), 1, 80) AS snippet FROM sources
         WHERE deleted = 0 AND (content LIKE ? OR excerpt LIKE ?) ORDER BY created_at DESC LIMIT ?`
      )
      .all(like, like, limit) as { id: string; snippet: string }[]
  }
  const getOne = getDb().prepare('SELECT * FROM sources WHERE id = ? AND deleted = 0')
  const countTasks = getDb().prepare('SELECT count(*) AS n FROM tasks WHERE source_id = ?')
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
