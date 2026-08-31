// 记事本插件（主进程）：笔记的增删改查、分类树维护，以及接收核心交来的内容（日报）。
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { localNowSec } from '@shared/parsing'
import {
  descendantIds,
  excerptOf,
  normalizeTags,
  titleFromContent,
  type NoteFolder,
  type NoteRecord,
  type NoteSummary
} from '@shared/notebook'
import type { PluginMainModule } from '../types.ts'

/** 日报存进来时归到这个分类下，省得和手写笔记混在一起。 */
const REPORT_FOLDER = '日报'

interface FolderRow {
  id: string
  name: string
  parent_id: string | null
  sort_order: number
  created_at: string
}

interface NoteRow {
  id: string
  folder_id: string | null
  title: string
  content: string
  tags: string | null
  pinned: number
  source: string | null
  source_ref: string | null
  created_at: string
  updated_at: string
}

const initTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p_notebook_folder (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS p_notebook_note (
      id TEXT PRIMARY KEY,
      folder_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_p_notebook_note_folder ON p_notebook_note(folder_id);
    CREATE INDEX IF NOT EXISTS idx_p_notebook_note_updated ON p_notebook_note(updated_at);
  `)
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? normalizeTags(parsed) : []
  } catch {
    return []
  }
}

const rowToSummary = (r: NoteRow): NoteSummary => ({
  id: r.id,
  folderId: r.folder_id,
  title: r.title,
  excerpt: excerptOf(r.content),
  tags: parseTags(r.tags),
  pinned: !!r.pinned,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

function listFolders(): NoteFolder[] {
  return (
    getDb()
      .prepare('SELECT * FROM p_notebook_folder ORDER BY sort_order, created_at')
      .all() as FolderRow[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    sortOrder: r.sort_order,
    createdAt: r.created_at
  }))
}

/** 复用同名顶层分类，没有就建一个。日报反复存入不会堆出一串同名分类。 */
function ensureFolder(name: string): string {
  const db = getDb()
  const row = db
    .prepare('SELECT id FROM p_notebook_folder WHERE name = ? AND parent_id IS NULL')
    .get(name) as { id: string } | undefined
  if (row) return row.id
  const id = randomUUID()
  db.prepare(
    'INSERT INTO p_notebook_folder (id, name, parent_id, sort_order, created_at) VALUES (?, ?, NULL, 0, ?)'
  ).run(id, name, localNowSec())
  return id
}

function insertNote(n: {
  folderId: string | null
  title: string
  content: string
  tags: string[]
  source?: string | null
  sourceRef?: string | null
}): string {
  const id = randomUUID()
  const now = localNowSec()
  getDb()
    .prepare(
      `INSERT INTO p_notebook_note
         (id, folder_id, title, content, tags, pinned, source, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(
      id,
      n.folderId,
      n.title,
      n.content,
      JSON.stringify(n.tags),
      n.source ?? null,
      n.sourceRef ?? null,
      now,
      now
    )
  return id
}

const notebook: PluginMainModule = {
  id: 'notebook',
  initTables,
  handlers: {
    /** 列表不带正文：几百篇长笔记也不会把这次 IPC 撑大。 */
    list: (): NoteSummary[] =>
      (
        getDb()
          .prepare('SELECT * FROM p_notebook_note ORDER BY updated_at DESC')
          .all() as NoteRow[]
      ).map(rowToSummary),

    get: (id: string): NoteRecord | null => {
      const row = getDb().prepare('SELECT * FROM p_notebook_note WHERE id = ?').get(id) as
        | NoteRow
        | undefined
      return row ? { ...rowToSummary(row), content: row.content } : null
    },

    create: (input: { folderId?: string | null; title?: string; content?: string; tags?: unknown[] }) => {
      const content = typeof input?.content === 'string' ? input.content : ''
      const title =
        (typeof input?.title === 'string' ? input.title.trim().slice(0, 200) : '') ||
        titleFromContent(content, '未命名')
      return {
        id: insertNote({
          folderId: input?.folderId ?? null,
          title,
          content,
          tags: normalizeTags(Array.isArray(input?.tags) ? input.tags : [])
        })
      }
    },

    update: (
      id: string,
      patch: {
        title?: string
        content?: string
        tags?: unknown[]
        folderId?: string | null
        pinned?: boolean
      }
    ): boolean => {
      const sets: string[] = []
      const vals: unknown[] = []
      if (typeof patch?.title === 'string') {
        sets.push('title = ?')
        vals.push(patch.title.trim().slice(0, 200) || '未命名')
      }
      if (typeof patch?.content === 'string') {
        sets.push('content = ?')
        vals.push(patch.content)
      }
      if (Array.isArray(patch?.tags)) {
        sets.push('tags = ?')
        vals.push(JSON.stringify(normalizeTags(patch.tags)))
      }
      if (patch?.folderId !== undefined) {
        sets.push('folder_id = ?')
        vals.push(patch.folderId || null)
      }
      if (typeof patch?.pinned === 'boolean') {
        sets.push('pinned = ?')
        vals.push(patch.pinned ? 1 : 0)
      }
      if (!sets.length) return false
      sets.push('updated_at = ?')
      vals.push(localNowSec(), id)
      getDb()
        .prepare(`UPDATE p_notebook_note SET ${sets.join(', ')} WHERE id = ?`)
        .run(...vals)
      return true
    },

    destroy: (id: string): boolean => {
      getDb().prepare('DELETE FROM p_notebook_note WHERE id = ?').run(id)
      return true
    },

    folders: (): NoteFolder[] => listFolders(),

    'folder-create': (name: string, parentId?: string | null) => {
      const clean = String(name ?? '').trim().slice(0, 60) || '新分类'
      const id = randomUUID()
      getDb()
        .prepare(
          'INSERT INTO p_notebook_folder (id, name, parent_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(id, clean, parentId || null, 0, localNowSec())
      return { id }
    },

    'folder-rename': (id: string, name: string): boolean => {
      const clean = String(name ?? '').trim().slice(0, 60)
      if (!clean) return false
      getDb().prepare('UPDATE p_notebook_folder SET name = ? WHERE id = ?').run(clean, id)
      return true
    },

    /** 挡住把分类拖进自己的子孙里——那会让这棵子树从树上整个消失。 */
    'folder-move': (id: string, parentId: string | null) => {
      if (id === parentId) return { ok: false, message: '不能移到它自己下面' }
      if (parentId && descendantIds(listFolders(), id).includes(parentId)) {
        return { ok: false, message: '不能移到自己的子分类下面' }
      }
      getDb()
        .prepare('UPDATE p_notebook_folder SET parent_id = ? WHERE id = ?')
        .run(parentId || null, id)
      return { ok: true }
    },

    /** 删分类不删笔记：删掉的是归类方式，内容退回上一级。 */
    'folder-delete': (id: string): boolean => {
      const db = getDb()
      const row = db.prepare('SELECT parent_id FROM p_notebook_folder WHERE id = ?').get(id) as
        | { parent_id: string | null }
        | undefined
      if (!row) return false
      db.transaction(() => {
        db.prepare('UPDATE p_notebook_note SET folder_id = ? WHERE folder_id = ?').run(
          row.parent_id,
          id
        )
        db.prepare('UPDATE p_notebook_folder SET parent_id = ? WHERE parent_id = ?').run(
          row.parent_id,
          id
        )
        db.prepare('DELETE FROM p_notebook_folder WHERE id = ?').run(id)
      })()
      return true
    },

    /**
     * 内容接收器（manifest 的 contentSinks）。核心日报页调它，
     * 传进来的是标题和 Markdown 正文——核心不知道这边会怎么存，也不需要知道。
     */
    'save-content': (input: { title?: string; content?: string; sourceRef?: string }) => {
      const content = typeof input?.content === 'string' ? input.content : ''
      if (!content.trim()) return { ok: false, message: '内容是空的，没有保存' }
      const title =
        (typeof input?.title === 'string' ? input.title.trim().slice(0, 200) : '') ||
        titleFromContent(content, '未命名')
      insertNote({
        folderId: ensureFolder(REPORT_FOLDER),
        title,
        content,
        tags: [REPORT_FOLDER],
        source: 'report',
        sourceRef: typeof input?.sourceRef === 'string' ? input.sourceRef : null
      })
      return { ok: true, message: `已存到记事本的「${REPORT_FOLDER}」` }
    }
  }
}

export default notebook
