// 作息插件（主进程）：时间块与模板的读写。
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db/connection.ts'
import { localNowSec } from '@shared/parsing'
import { dayKey } from '@shared/work-report'
import {
  applyTemplate,
  isValidRange,
  labelToMinutes,
  type BlockDraft,
  type TimeBlock,
  type TemplateBlock,
  type TimeTemplate
} from '@shared/timeblock'
import { ALL_DAY_TYPES, normalizeDayTypes } from '@shared/holidays'
import type { AchievementCounter, PluginMainModule } from '../types.ts'

interface BlockRow {
  id: string
  date: string
  start_min: number
  end_min: number
  title: string
  tag: string | null
  task_id: string | null
  done: number
  template_id: string | null
  focus_minutes: number | null
  created_at: string
}

interface TemplateRow {
  id: string
  name: string
  weekdays: string
  day_types: string
  created_at: string
}

interface TemplateBlockRow {
  id: string
  template_id: string
  start_min: number
  end_min: number
  title: string
  tag: string | null
}

function toBlock(r: BlockRow): TimeBlock {
  return {
    id: r.id,
    date: r.date,
    startMin: r.start_min,
    endMin: r.end_min,
    title: r.title,
    tag: r.tag,
    taskId: r.task_id,
    done: !!r.done,
    templateId: r.template_id,
    focusMinutes: r.focus_minutes ?? 0,
    createdAt: r.created_at
  }
}

function normalizeWeekdays(days: readonly number[]): number[] {
  return [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toTemplate(r: TemplateRow): TimeTemplate {
  return {
    id: r.id,
    name: r.name,
    weekdays: parseJsonArray(r.weekdays).filter((n): n is number => typeof n === 'number'),
    dayTypes: normalizeDayTypes(parseJsonArray(r.day_types)),
    createdAt: r.created_at
  }
}

function toTemplateBlock(r: TemplateBlockRow): TemplateBlock {
  return {
    id: r.id,
    templateId: r.template_id,
    startMin: r.start_min,
    endMin: r.end_min,
    title: r.title,
    tag: r.tag
  }
}

function listBlocks(date: string): TimeBlock[] {
  const rows = getDb()
    .prepare('SELECT * FROM p_timeblock_block WHERE date = ? ORDER BY start_min, end_min')
    .all(date) as BlockRow[]
  return rows.map(toBlock)
}

// 返回值刻意不叫 blocks：day handler 要同时给出「当天的块」和「模板里的块」，
// 两个都叫 blocks 的话展开时会互相覆盖。
function listTemplates(): { templates: TimeTemplate[]; templateBlocks: TemplateBlock[] } {
  const db = getDb()
  const templates = (db.prepare('SELECT * FROM p_timeblock_template ORDER BY created_at').all() as TemplateRow[]).map(toTemplate)
  const templateBlocks = (
    db.prepare('SELECT * FROM p_timeblock_template_block ORDER BY start_min').all() as TemplateBlockRow[]
  ).map(toTemplateBlock)
  return { templates, templateBlocks }
}

function insertBlock(draft: BlockDraft): TimeBlock | null {
  if (!isValidRange(draft.startMin, draft.endMin)) return null
  const title = draft.title.trim()
  if (!title) return null
  const row: TimeBlock = {
    ...draft,
    title,
    id: randomUUID(),
    focusMinutes: 0,
    createdAt: localNowSec()
  }
  getDb()
    .prepare(
      `INSERT INTO p_timeblock_block (id, date, start_min, end_min, title, tag, task_id, done, template_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.date,
      row.startMin,
      row.endMin,
      row.title,
      row.tag,
      row.taskId,
      row.done ? 1 : 0,
      row.templateId,
      row.createdAt
    )
  return row
}

const initTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p_timeblock_block (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      title TEXT NOT NULL,
      tag TEXT,
      task_id TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      template_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_p_timeblock_block_date ON p_timeblock_block(date);
    CREATE TABLE IF NOT EXISTS p_timeblock_template (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      weekdays TEXT NOT NULL DEFAULT '[]',
      day_types TEXT NOT NULL DEFAULT '["workday","weekend","holiday"]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS p_timeblock_template_block (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      title TEXT NOT NULL,
      tag TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_p_timeblock_tb_template ON p_timeblock_template_block(template_id);
  `)
  // 增量迁移：专注回写的累计分钟数是后加的，只加列，旧行取 0
  const cols = (db.prepare('PRAGMA table_info(p_timeblock_block)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!cols.includes('focus_minutes'))
    db.exec('ALTER TABLE p_timeblock_block ADD COLUMN focus_minutes INTEGER NOT NULL DEFAULT 0')

  // 增量迁移：日子性质是后加的维度。旧模板默认三类全选，等于「只看星期」——
  // 保持它们升级前后的行为完全一致。
  const tplCols = (
    db.prepare('PRAGMA table_info(p_timeblock_template)').all() as { name: string }[]
  ).map((c) => c.name)
  if (!tplCols.includes('day_types'))
    db.exec(
      `ALTER TABLE p_timeblock_template ADD COLUMN day_types TEXT NOT NULL DEFAULT '${JSON.stringify(ALL_DAY_TYPES)}'`
    )
}

const timeblock: PluginMainModule = {
  id: 'timeblock',
  initTables,

  // 「作息」不认识「专注」，只认识一个事件名。没装专注插件就永远收不到，
  // 这里也不需要任何 if 判断——这正是插件能随意抽插的原因。
  on: {
    'pomodoro:round-completed': (payload) => {
      const blockId = typeof payload.blockId === 'string' ? payload.blockId : null
      if (!blockId) return // 这一轮没关联时间块，与作息无关
      const minutes = Math.max(0, Math.round(Number(payload.actualMinutes) || 0))
      if (!minutes) return
      getDb()
        .prepare('UPDATE p_timeblock_block SET focus_minutes = COALESCE(focus_minutes, 0) + ? WHERE id = ?')
        .run(minutes, blockId)
    }
  },

  handlers: {
    day: (date: string) => ({ blocks: listBlocks(date), ...listTemplates() }),

    create: (draft: BlockDraft) => insertBlock(draft),

    update: (id: string, patch: Partial<TimeBlock>) => {
      const db = getDb()
      const row = db.prepare('SELECT * FROM p_timeblock_block WHERE id = ?').get(id) as BlockRow | undefined
      if (!row) return null
      const next = { ...toBlock(row), ...patch, id: row.id }
      if (!isValidRange(next.startMin, next.endMin)) return null
      db.prepare(
        `UPDATE p_timeblock_block
         SET date = ?, start_min = ?, end_min = ?, title = ?, tag = ?, task_id = ?, done = ?
         WHERE id = ?`
      ).run(
        next.date,
        next.startMin,
        next.endMin,
        next.title.trim() || row.title,
        next.tag,
        next.taskId,
        next.done ? 1 : 0,
        id
      )
      return next
    },

    delete: (id: string) => {
      getDb().prepare('DELETE FROM p_timeblock_block WHERE id = ?').run(id)
      return true
    },

    /** 把一个块复制到另一天（默认次日），常用于「明天同样再来一遍」。 */
    copy: (id: string, toDate: string) => {
      const row = getDb().prepare('SELECT * FROM p_timeblock_block WHERE id = ?').get(id) as
        | BlockRow
        | undefined
      if (!row) return null
      const src = toBlock(row)
      return insertBlock({ ...src, date: toDate, done: false, templateId: null })
    },

    /** 整天复制到另一天，跳过已存在同名同时段的块，避免重复点两次翻倍。 */
    'copy-day': (fromDate: string, toDate: string) => {
      const src = listBlocks(fromDate)
      const existing = listBlocks(toDate)
      const created = src
        .filter(
          (b) => !existing.some((e) => e.startMin === b.startMin && e.endMin === b.endMin && e.title === b.title)
        )
        .map((b) => insertBlock({ ...b, date: toDate, done: false, templateId: null }))
        .filter((b): b is TimeBlock => b !== null)
      return created.length
    },

    'template-save': (
      name: string,
      weekdays: number[],
      dayTypes: string[],
      blocks: Omit<TemplateBlock, 'id' | 'templateId'>[]
    ) => {
      const trimmed = name.trim()
      if (!trimmed) return null
      const db = getDb()
      const id = randomUUID()
      const insertTpl = db.prepare(
        'INSERT INTO p_timeblock_template (id, name, weekdays, day_types, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      const insertBlk = db.prepare(
        `INSERT INTO p_timeblock_template_block (id, template_id, start_min, end_min, title, tag)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      // 模板和它的块必须一起落库，否则会留下没有块的空模板
      db.transaction(() => {
        insertTpl.run(
          id,
          trimmed,
          JSON.stringify(normalizeWeekdays(weekdays)),
          JSON.stringify(normalizeDayTypes(dayTypes)),
          localNowSec()
        )
        for (const b of blocks) {
          if (!isValidRange(b.startMin, b.endMin) || !b.title.trim()) continue
          insertBlk.run(randomUUID(), id, b.startMin, b.endMin, b.title.trim(), b.tag)
        }
      })()
      return id
    },

    /**
     * 改模板的名字和适用范围。块不在这里改——要换内容就重新「把今天存为模板」，
     * 省掉一套块编辑 UI，而范围是唯一会反复调的东西。
     */
    'template-update': (
      id: string,
      patch: { name?: string; weekdays?: number[]; dayTypes?: string[] }
    ) => {
      const db = getDb()
      const row = db.prepare('SELECT * FROM p_timeblock_template WHERE id = ?').get(id) as
        | TemplateRow
        | undefined
      if (!row) return null
      const cur = toTemplate(row)
      const name = patch.name?.trim() || cur.name
      const weekdays = patch.weekdays ? normalizeWeekdays(patch.weekdays) : cur.weekdays
      const dayTypes = patch.dayTypes ? normalizeDayTypes(patch.dayTypes) : cur.dayTypes
      db.prepare('UPDATE p_timeblock_template SET name = ?, weekdays = ?, day_types = ? WHERE id = ?').run(
        name,
        JSON.stringify(weekdays),
        JSON.stringify(dayTypes),
        id
      )
      return { ...cur, name, weekdays, dayTypes }
    },

    'template-delete': (id: string) => {
      const db = getDb()
      db.transaction(() => {
        db.prepare('DELETE FROM p_timeblock_template_block WHERE template_id = ?').run(id)
        db.prepare('DELETE FROM p_timeblock_template WHERE id = ?').run(id)
      })()
      return true
    },

    'template-apply': (templateId: string, date: string) => {
      const { templates, templateBlocks } = listTemplates()
      const tpl = templates.find((t) => t.id === templateId)
      if (!tpl) return []
      // 覆盖式套用：先清掉这天由模板生成的块，手动加的块保留
      getDb().prepare('DELETE FROM p_timeblock_block WHERE date = ? AND template_id IS NOT NULL').run(date)
      return applyTemplate(tpl, templateBlocks, date)
        .map(insertBlock)
        .filter((b): b is TimeBlock => b !== null)
    }
  },

  // 「下午两点到四点看论文」走到这里。时间一律经 labelToMinutes 解析，
  // 解析不出来就明确失败，不去猜——排错时间比不排更糟。
  assistantActions: {
    'add-block': (args) => {
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 60) : ''
      if (!title) return { ok: false, message: '没说要做什么' }
      const startMin = typeof args.start === 'string' ? labelToMinutes(args.start) : null
      const endMin = typeof args.end === 'string' ? labelToMinutes(args.end) : null
      if (startMin === null || endMin === null) return { ok: false, message: '时间没看懂' }
      if (!isValidRange(startMin, endMin)) return { ok: false, message: '结束时间要晚于开始时间' }
      const date =
        typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)
          ? args.date
          : dayKey(new Date())
      const row = insertBlock({
        date,
        startMin,
        endMin,
        title,
        tag: null,
        taskId: null,
        done: false,
        templateId: null
      })
      if (!row) return { ok: false, message: '没能排上' }
      const when = date === dayKey(new Date()) ? '今天' : date
      return { ok: true, message: `${when} ${args.start}–${args.end} 排上了：${title}` }
    }
  },

  counters: (): AchievementCounter[] => {
    const db = getDb()
    const one = (sql: string): number =>
      ((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0)
    return [
      { key: 'timeblock_blocks', value: one('SELECT COUNT(*) AS n FROM p_timeblock_block') },
      { key: 'timeblock_templates', value: one('SELECT COUNT(*) AS n FROM p_timeblock_template') },
      {
        key: 'timeblock_planned_days',
        value: one('SELECT COUNT(DISTINCT date) AS n FROM p_timeblock_block')
      }
    ]
  }
}

export default timeblock
