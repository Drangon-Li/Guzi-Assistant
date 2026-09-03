// detections：屏幕感知的本地检测历史与用户备注（被动留存，供「记忆」页回看）。
import { getDb } from './connection.ts'
import { localNow } from '@shared/parsing'
import type { DetectionRecord } from '@shared/types'
import { dayKey } from '@shared/work-report'
import { randomUUID } from 'crypto'

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
  /** 没过入队门槛的候选存成 archived：留痕参与去重，但不进用户的待确认队列（#128） */
  status?: DetectionRecord['status']
}): { detection: DetectionRecord; isNew: boolean } {
  const dup = getDb()
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
    status: input.status ?? 'new',
    createdAt: localNow()
  }
  getDb().prepare(
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
  getDb().exec(
    'DELETE FROM detections WHERE id NOT IN (SELECT id FROM detections ORDER BY created_at DESC LIMIT 300)'
  )
  return { detection: rec, isNew: true }
}

export function listDetections(limit = 40): DetectionRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM detections ORDER BY created_at DESC LIMIT ?')
    .all(limit) as DetectionRow[]
  return rows.map(rowToDetection)
}

export function getDetection(id: string): DetectionRecord | null {
  const row = getDb().prepare('SELECT * FROM detections WHERE id = ?').get(id) as DetectionRow | undefined
  return row ? rowToDetection(row) : null
}

export function setDetectionStatus(id: string, status: DetectionRecord['status']): void {
  getDb().prepare('UPDATE detections SET status = ? WHERE id = ?').run(status, id)
}

/** 仍在等用户确认的检测（供「完成即撤」拿去和当前屏幕文字比对）。 */
export function listPendingDetections(limit = 60): DetectionRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM detections WHERE status='new' ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DetectionRow[]
  return rows.map(rowToDetection)
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
  getDb().prepare(
    "UPDATE detections SET status='dismissed' WHERE status='new' AND ((time_iso IS NOT NULL AND deadline=0 AND time_iso < ?) OR created_at < ?)"
  ).run(at(Date.now() - 86_400_000), at(Date.now() - 7 * 86_400_000))
  // 屏幕 OCR 原文是高敏临时证据；48 小时后只保留标题、时间、应用和处理状态。
  getDb().prepare("UPDATE detections SET source_text='' WHERE source_text != '' AND created_at < ?").run(
    at(Date.now() - 48 * 60 * 60 * 1000)
  )
}

// ---------- detection_notes（检测卡「备注」：用户对检测结果的人工反馈，个性化学习素材）----------

export function addDetectionNote(detectionId: string | null, title: string, note: string): void {
  getDb().prepare(
    'INSERT INTO detection_notes (id, detection_id, title, note, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), detectionId, title.slice(0, 120), note.slice(0, 200), localNow())
}

/** 近期备注（默认 14 天内最多 8 条，新的在前）——注入提示词用，条数刻意收紧防噪声。 */
export function listRecentDetectionNotes(
  days = 14,
  limit = 8
): { title: string; note: string }[] {
  const since = dayKey(new Date(Date.now() - days * 86_400_000))
  return getDb()
    .prepare(
      'SELECT title, note FROM detection_notes WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(since, limit) as { title: string; note: string }[]
}
