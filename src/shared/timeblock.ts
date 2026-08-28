// 作息插件的纯逻辑：时间块的排布、重叠判定、模板套用与空档计算。
//
// 时刻一律用「距零点的分钟数」(0..1440) 存，不用 ISO 字符串——时间块是「每天几点到几点」
// 这种与具体日期无关的概念，模板要能原样套到任何一天，用绝对时刻反而要反复拆装。
// 日期单独一列，口径跟随核心的 dayKey（自然日零点），不另立业务日。

export interface TimeBlock {
  id: string
  /** YYYY-MM-DD */
  date: string
  /** 距零点的分钟数，含 */
  startMin: number
  /** 距零点的分钟数，不含；允许 1440 表示到当天结束 */
  endMin: number
  title: string
  tag: string | null
  /** 可选地关联一个任务；作息块本身不是任务 */
  taskId: string | null
  done: boolean
  /** 由哪个模板套用而来，手动新建为 null */
  templateId: string | null
  createdAt: string
}

export interface TemplateBlock {
  id: string
  templateId: string
  startMin: number
  endMin: number
  title: string
  tag: string | null
}

export interface TimeTemplate {
  id: string
  name: string
  /** 0=周日 … 6=周六；命中的星期几进入这一天会提示套用 */
  weekdays: number[]
  createdAt: string
}

export const DAY_MINUTES = 1440

/** 分钟数 → HH:MM。1440 显示为 24:00，比 00:00 更贴合「到当天结束」的语义。 */
export function minutesToLabel(min: number): string {
  const m = Math.max(0, Math.min(DAY_MINUTES, Math.round(min)))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** HH:MM → 分钟数；解析不了返回 null。 */
export function labelToMinutes(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(label.trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 24 || mm > 59 || (h === 24 && mm > 0)) return null
  return h * 60 + mm
}

/** 「1 小时 30 分钟」；不足 1 小时只说分钟。 */
export function durationLabel(startMin: number, endMin: number): string {
  const total = Math.max(0, endMin - startMin)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

/** 起止是否构成一个合法区间。 */
export function isValidRange(startMin: number, endMin: number): boolean {
  return (
    Number.isInteger(startMin) &&
    Number.isInteger(endMin) &&
    startMin >= 0 &&
    endMin <= DAY_MINUTES &&
    startMin < endMin
  )
}

interface Span {
  startMin: number
  endMin: number
}

/** 两段是否重叠。相邻（前一段的 end 等于后一段的 start）不算重叠。 */
export function overlaps(a: Span, b: Span): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin
}

export function sortBlocks<T extends Span>(blocks: readonly T[]): T[] {
  return [...blocks].sort((x, y) => x.startMin - y.startMin || x.endMin - y.endMin)
}

/**
 * 与已有块冲突的那些。作息表允许重叠（同一段时间可以既是「会议」又是「远程」），
 * 所以这里只用来提示，不用来拒绝写入——拒绝会让用户没法先排后调。
 */
export function conflictsWith<T extends Span & { id: string }>(
  blocks: readonly T[],
  span: Span,
  ignoreId?: string
): T[] {
  return blocks.filter((b) => b.id !== ignoreId && overlaps(b, span))
}

/** 一天里没有被任何块覆盖的空档，按时间排序；只返回长度 >= minGap 分钟的。 */
export function freeGaps(
  blocks: readonly Span[],
  dayStartMin = 0,
  dayEndMin = DAY_MINUTES,
  minGap = 15
): Span[] {
  const merged: Span[] = []
  for (const b of sortBlocks(blocks)) {
    const start = Math.max(b.startMin, dayStartMin)
    const end = Math.min(b.endMin, dayEndMin)
    if (start >= end) continue
    const last = merged[merged.length - 1]
    if (last && start <= last.endMin) last.endMin = Math.max(last.endMin, end)
    else merged.push({ startMin: start, endMin: end })
  }

  const gaps: Span[] = []
  let cursor = dayStartMin
  for (const m of merged) {
    if (m.startMin - cursor >= minGap) gaps.push({ startMin: cursor, endMin: m.startMin })
    cursor = Math.max(cursor, m.endMin)
  }
  if (dayEndMin - cursor >= minGap) gaps.push({ startMin: cursor, endMin: dayEndMin })
  return gaps
}

/** 一天已排出去的总分钟数（重叠部分只算一次）。 */
export function plannedMinutes(blocks: readonly Span[]): number {
  return freeGaps(blocks, 0, DAY_MINUTES, 1).reduce(
    (rest, gap) => rest - (gap.endMin - gap.startMin),
    DAY_MINUTES
  )
}

/** 模板套用到某一天，产出待写入的块草稿；id 和 createdAt 由调用方补。 */
export type BlockDraft = Omit<TimeBlock, 'id' | 'createdAt'>

export function applyTemplate(
  template: TimeTemplate,
  templateBlocks: readonly TemplateBlock[],
  date: string
): BlockDraft[] {
  return sortBlocks(templateBlocks.filter((b) => b.templateId === template.id)).map((b) => ({
    date,
    startMin: b.startMin,
    endMin: b.endMin,
    title: b.title,
    tag: b.tag,
    taskId: null,
    done: false,
    templateId: template.id
  }))
}

/** 这一天该自动提示套用哪个模板；命中多个取最早建的那个。 */
export function templateForDate(templates: readonly TimeTemplate[], date: string): TimeTemplate | null {
  const d = new Date(`${date}T12:00:00`)
  if (Number.isNaN(d.getTime())) return null
  const weekday = d.getDay()
  const hit = templates
    .filter((t) => t.weekdays.includes(weekday))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return hit[0] ?? null
}

/**
 * 计划块与实际工作记录的对照。actual 用的是实际起止的分钟区间，
 * 返回每个计划块被实际活动覆盖的比例（0..1）——作息页的「计划 vs 实际」就画这个。
 */
export function coverageOf(block: Span, actual: readonly Span[]): number {
  const span = block.endMin - block.startMin
  if (span <= 0) return 0
  let covered = 0
  let cursor = block.startMin
  for (const a of sortBlocks(actual)) {
    const start = Math.max(a.startMin, cursor)
    const end = Math.min(a.endMin, block.endMin)
    if (start >= end) continue
    covered += end - start
    cursor = end
  }
  return Math.min(1, covered / span)
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/** [1,2,3,4,5] → 「周一至周五」；不连续则列举，空数组返回「不自动套用」。 */
export function weekdaysLabel(weekdays: readonly number[]): string {
  const days = [...new Set(weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
  if (!days.length) return '不自动套用'
  if (days.length === 7) return '每天'
  const isRun = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  if (isRun && days.length > 2) return `周${WEEKDAY_LABELS[days[0]]}至周${WEEKDAY_LABELS[days[days.length - 1]]}`
  return days.map((d) => `周${WEEKDAY_LABELS[d]}`).join('、')
}
