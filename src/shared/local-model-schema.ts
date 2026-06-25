/**
 * 屏幕感知本地小模型的纯逻辑层：grammar JSON schema、模型输出校验/强转、选优、升级判定、prompt。
 * 纯函数、零依赖，可离线单测；不 import 任何 electron/native。
 */
import type { Belongs, LocalExtraction } from './types'

const BELONGS: Belongs[] = ['yes', 'no', 'uncertain']
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** grammar 用 JSON schema：顶层数组，无日程时模型可合法输出 []（不加 minItems，否则逼模型硬编）。 */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      isoTime: { type: ['string', 'null'] },
      deadline: { type: 'boolean' },
      belongsToUser: { enum: ['yes', 'no', 'uncertain'] },
      hits: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
      needsVlm: { type: 'boolean' }
    }
  }
} as const

const clamp01 = (n: unknown): number => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** ISO 含日期（YYYY-MM-DDTHH:mm）才算 strong。模型应输出完整 ISO 或 null。 */
function hasDate(iso: string | null): boolean {
  return !!iso && ISO_RE.test(iso)
}

/** 把模型解析出的原始 JSON 强转成干净的 LocalExtraction[]，丢弃无 title 的脏项。绝不编造时间。 */
export function coerceExtractions(raw: unknown, _now: Date = new Date()): LocalExtraction[] {
  if (!Array.isArray(raw)) return []
  const out: LocalExtraction[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    if (!title) continue
    const iso = typeof o.isoTime === 'string' && ISO_RE.test(o.isoTime) ? o.isoTime.slice(0, 16) : null
    const belongs = BELONGS.includes(o.belongsToUser as Belongs)
      ? (o.belongsToUser as Belongs)
      : 'uncertain'
    const hits = Array.isArray(o.hits) ? o.hits.filter((h): h is string => typeof h === 'string') : []
    out.push({
      title: title.slice(0, 80),
      isoTime: iso,
      deadline: o.deadline === true,
      belongsToUser: belongs,
      hits,
      confidence: clamp01(o.confidence),
      needsVlm: o.needsVlm === true || o.needsVlm === 1,
      strong: hasDate(iso)
    })
  }
  return out
}

/** 一帧多事项时挑一条进检测/弹卡：优先 strong，再比置信度。 */
export function pickBestExtraction(items: LocalExtraction[]): LocalExtraction | null {
  if (!items.length) return null
  return [...items].sort(
    (a, b) => Number(b.strong) - Number(a.strong) || b.confidence - a.confidence
  )[0]
}

/** 是否需要上云 VLM 复核：模型自判 needsVlm 或本地置信度不足。 */
export function shouldEscalate(e: Pick<LocalExtraction, 'needsVlm' | 'confidence'>, confMin: number): boolean {
  return e.needsVlm || e.confidence < confMin
}

export const SYSTEM_PROMPT = [
  '你是一个本地日程抽取器。从给定的屏幕文字里抽出"用户需要去做/参加/截止"的待办事项。',
  '只输出 JSON 数组，每个元素字段：',
  '- title: 事项简短标题',
  '- isoTime: 事件时间，格式严格 "YYYY-MM-DDTHH:mm"；解析不出具体日期就填 null，绝不编造',
  '- deadline: 是否截止性质（"前交/截止/DDL"）',
  '- belongsToUser: 这件事是不是用户本人的，取 "yes"/"no"/"uncertain"',
  '- hits: 命中的关键信号词数组（如 "组会"/"考试"）',
  '- confidence: 0~1 的置信度',
  '- needsVlm: 信息不全/拿不准、需要更强模型复核时填 true',
  '规则：屏幕上没有任何明确待办时，必须返回空数组 []；不要编造时间或事项；过去已发生、已取消、不是用户的事降低置信度或标 needsVlm。'
].join('\n')

/** 拼用户消息：当前时间锚点（供相对日期解析）+ 自称（供归属初判）+ OCR 文本。 */
export function buildExtractionPrompt(text: string, opts: { now: Date; selfNames?: string[] }): string {
  const y = opts.now.getFullYear()
  const mo = String(opts.now.getMonth() + 1).padStart(2, '0')
  const d = String(opts.now.getDate()).padStart(2, '0')
  const hh = String(opts.now.getHours()).padStart(2, '0')
  const mm = String(opts.now.getMinutes()).padStart(2, '0')
  const wd = ['日', '一', '二', '三', '四', '五', '六'][opts.now.getDay()]
  const self = opts.selfNames?.filter(Boolean).length
    ? `用户本人常用称呼：${opts.selfNames.join('、')}。`
    : ''
  return [
    `当前时间：${y}-${mo}-${d}T${hh}:${mm}（周${wd}），相对日期以此为基准。`,
    self,
    '屏幕文字：',
    '"""',
    text.slice(0, 4000),
    '"""',
    '只返回 JSON 数组，没有待办就返回 []。'
  ]
    .filter(Boolean)
    .join('\n')
}
