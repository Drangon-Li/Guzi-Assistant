// 记事本插件（主进程）：笔记的增删改查、分类树维护，以及接收核心交来的内容（日报）。
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { localNowSec } from '@shared/parsing'
import { readPluginSetting, writePluginSetting } from '../../db/plugins.ts'
import {
  descendantIds,
  excerptOf,
  normalizePrefs,
  normalizeTags,
  titleFromContent,
  visibleToAssistant,
  type NoteFolder,
  type NotebookPrefs,
  type NoteRecord,
  type NoteSummary
} from '@shared/notebook'
import type { PluginMainModule } from '../types.ts'

/** 日报存进来时归到这个分类下，省得和手写笔记混在一起。 */
const REPORT_FOLDER = '日报'

/** 笔记里的图片存在这儿，按内容 SHA-256 命名——同一张图拖十次也只占一份。 */
const ASSET_DIR = 'notebook-assets'
const ASSET_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
/** 单张图上限。再大的图塞进笔记，打开这一篇就会明显卡一下。 */
const ASSET_MAX_BYTES = 10 * 1024 * 1024
/** 只认自己写出去的文件名，挡住 ../ 这类路径穿越。 */
const ASSET_ID_RE = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/

function readPrefs(): NotebookPrefs {
  const raw = readPluginSetting('notebook', 'prefs')
  if (!raw) return normalizePrefs(null)
  try {
    return normalizePrefs(JSON.parse(raw))
  } catch {
    return normalizePrefs(null)
  }
}

function assetDir(): string {
  const dir = join(app.getPath('userData'), ASSET_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

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

    /**
     * 存一张拖进来的图，返回文件名。正文里只留这个名字，图片本体在 userData 下，
     * 不进数据库——把 base64 塞进笔记正文会让这一篇每次读写都拖着几 MB 走。
     */
    'save-image': (input: { dataUrl?: string }) => {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(input?.dataUrl ?? ''))
      const ext = m ? ASSET_TYPES[m[1].toLowerCase()] : undefined
      if (!m || !ext) return { ok: false, message: '只支持 PNG、JPEG、WebP 和 GIF' }
      const buf = Buffer.from(m[2], 'base64')
      if (!buf.length) return { ok: false, message: '图片是空的' }
      if (buf.length > ASSET_MAX_BYTES) return { ok: false, message: '图片超过 10 MB' }
      const id = `${createHash('sha256').update(buf).digest('hex')}.${ext}`
      const path = join(assetDir(), id)
      if (!existsSync(path)) writeFileSync(path, buf)
      return { ok: true, id }
    },

    /** 渲染层拿它填 img 的 src：CSP 只放行 self 和 data:，所以这里回 data URL。 */
    'read-image': (id: string): string | null => {
      if (!ASSET_ID_RE.test(String(id ?? ''))) return null
      const path = join(assetDir(), id)
      if (!existsSync(path)) return null
      const ext = id.split('.').pop() as string
      const mime = Object.entries(ASSET_TYPES).find(([, e]) => e === ext)?.[0] ?? 'image/png'
      try {
        return `data:${mime};base64,${readFileSync(path).toString('base64')}`
      } catch {
        return null
      }
    },

    folders: (): NoteFolder[] => listFolders(),

    prefs: (): NotebookPrefs => readPrefs(),

    'set-prefs': (patch: Partial<NotebookPrefs>): NotebookPrefs => {
      const next = normalizePrefs({ ...readPrefs(), ...(patch ?? {}) })
      writePluginSetting('notebook', 'prefs', JSON.stringify(next))
      return next
    },

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
  },

  /**
   * 给助手看的笔记清单：只有标题和一句摘要，正文不给——一整篇塞进提示词又长又没必要。
   * 设置里排除掉的分类和笔记在这里就已经滤掉了，宿主拿到的就是能看的那些。
   */
  assistantContext: () => {
    const prefs = readPrefs()
    const all = (
      getDb()
        .prepare('SELECT * FROM p_notebook_note ORDER BY updated_at DESC LIMIT 200')
        .all() as NoteRow[]
    ).map(rowToSummary)
    const visible = visibleToAssistant(all, listFolders(), prefs).slice(0, 40)
    if (!visible.length) return ''
    const lines = visible.map((n) => `- ${n.title}${n.excerpt ? `：${n.excerpt}` : ''}`)
    return `记事本里的笔记（共 ${visible.length} 篇，按最近改动排）：\n${lines.join('\n')}`
  },

  assistantActions: {
    /** 参数来自模型输出，一律当不可信输入校验。 */
    'create-note': (args) => {
      const content = typeof args.content === 'string' ? args.content : ''
      const rawTitle = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : ''
      if (!rawTitle && !content.trim()) return { ok: false, message: '没说要记什么' }
      const title = rawTitle || titleFromContent(content, '未命名')
      const folderName = typeof args.folder === 'string' ? args.folder.trim().slice(0, 60) : ''
      insertNote({
        folderId: folderName ? ensureFolder(folderName) : null,
        title,
        content,
        tags: normalizeTags(Array.isArray(args.tags) ? args.tags : [])
      })
      return {
        ok: true,
        message: folderName ? `已记到记事本的「${folderName}」：${title}` : `已记到记事本：${title}`
      }
    }
  }
}

export default notebook
