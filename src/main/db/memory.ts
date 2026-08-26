// personal_memory / focus_tasks：两段个人画像，以及任务专注的人工校正偏好。
import { getDb } from './connection.ts'
import { listRecentDetectionNotes } from './detections.ts'
import { localNow } from '@shared/parsing'
import { normalizeTaskKey, normalizeTaskLabel } from '@shared/work-report'

// ---------- personal_memory（两段画像：base=用户身份的长期定义（手动维护），recent=近期行为/任务画像（AI 归纳））----------

export interface PersonalMemory {
  /** 基本画像：用户身份的长期定义，手动维护 */
  base: string
  /** 近期行为画像：AI 从近期工作记录归纳，可刷新 */
  recent: string
  updatedAt: string | null
}

export function getPersonalMemory(): PersonalMemory {
  const row = getDb()
    .prepare('SELECT base_content, content, updated_at FROM personal_memory WHERE id = 1')
    .get() as { base_content: string; content: string; updated_at: string | null } | undefined
  return { base: row?.base_content ?? '', recent: row?.content ?? '', updatedAt: row?.updated_at ?? null }
}

/** 更新画像的某一段（另一段保持原值），返回最新完整画像。 */
export function setPersonalMemory(part: 'base' | 'recent', content: string): PersonalMemory {
  const cur = getPersonalMemory()
  const next = { base: part === 'base' ? content : cur.base, recent: part === 'recent' ? content : cur.recent }
  const updatedAt = localNow()
  getDb().prepare(
    'INSERT INTO personal_memory (id, base_content, content, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET base_content = excluded.base_content, content = excluded.content, updated_at = excluded.updated_at'
  ).run(next.base, next.recent, updatedAt)
  return { ...next, updatedAt }
}

/** 注入 prompt 用：两段画像拼接（空段省略）。 */
export function personalMemoryText(): string {
  const m = getPersonalMemory()
  const parts: string[] = []
  if (m.base.trim()) parts.push(`【基本画像】\n${m.base.trim()}`)
  if (m.recent.trim()) parts.push(`【近期行为画像】\n${m.recent.trim()}`)
  // 检测卡「备注」反馈：直接进解析/助手提示词，判断归属与取舍时优先遵循用户的人工纠错
  const notes = listRecentDetectionNotes()
  if (notes.length)
    parts.push(
      `【近期纠错备注】（用户对自动检测的人工反馈，同类判断优先遵循）\n${notes
        .map((n) => `- 「${n.title}」：${n.note}`)
        .join('\n')}`
    )
  return parts.join('\n')
}

// ---------- focus_tasks（任务专注：用户自定义/隐藏的任务名偏好，用于校正模型的任务归并）----------

export interface FocusTaskPref {
  name: string
  hidden: boolean
  custom: boolean
}

export function listFocusTaskPrefs(): FocusTaskPref[] {
  const rows = getDb().prepare('SELECT name, hidden, custom FROM focus_tasks').all() as {
    name: string
    hidden: number
    custom: number
  }[]
  return rows.map((r) => ({ name: r.name, hidden: !!r.hidden, custom: !!r.custom }))
}

export function addFocusTask(name: string): void {
  const n = normalizeTaskLabel(name, 60)
  if (!n) return
  getDb().prepare(
    'INSERT INTO focus_tasks (name, hidden, custom, created_at) VALUES (?, 0, 1, ?) ON CONFLICT(name) DO UPDATE SET hidden = 0'
  ).run(n, localNow())
}

/** 「删除」一个任务：标记隐藏（不进展示、不进模型候选）。 */
export function hideFocusTask(name: string): void {
  const n = normalizeTaskLabel(name, 60)
  if (!n) return
  getDb().prepare(
    'INSERT INTO focus_tasks (name, hidden, custom, created_at) VALUES (?, 1, 0, ?) ON CONFLICT(name) DO UPDATE SET hidden = 1'
  ).run(n, localNow())
}

/** 模型的任务名候选：近 3 天出现过的任务 + 用户自定义，剔除隐藏，最多 12 个。 */
export function listFocusTaskCandidates(): string[] {
  const since = new Date()
  since.setDate(since.getDate() - 3)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sinceKey = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`
  const derived = (
    getDb()
      .prepare(
        'SELECT DISTINCT task FROM work_records WHERE task IS NOT NULL AND COALESCE(start_at, created_at) >= ? ORDER BY COALESCE(start_at, created_at) DESC'
      )
      .all(sinceKey) as { task: string }[]
  ).map((r) => r.task)
  const prefs = listFocusTaskPrefs()
  const hidden = new Set(prefs.filter((p) => p.hidden).map((p) => normalizeTaskKey(p.name)))
  const custom = prefs.filter((p) => p.custom && !p.hidden).map((p) => p.name)
  // 按归一键去重：同一任务的空格/大小写变体只给模型一个候选，否则列表被近重复挤满、
  // 模型也更容易在变体间摇摆（任务专注拆条的源头）
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of [...custom, ...derived]) {
    const key = normalizeTaskKey(n)
    if (hidden.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(n)
    if (out.length >= 12) break
  }
  return out
}
