// reports：AI 生成的工作日报。
import { getDb } from './connection.ts'
import { localNow } from '@shared/parsing'
import type { ReportRecord } from '@shared/types'
import { randomUUID } from 'crypto'

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
  getDb().prepare('INSERT INTO reports (id, day, type, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
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
  const rows = getDb()
    .prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?')
    .all(limit) as ReportRow[]
  return rows.map(rowToReport)
}

export function deleteReport(id: string): void {
  getDb().prepare('DELETE FROM reports WHERE id = ?').run(id)
}
