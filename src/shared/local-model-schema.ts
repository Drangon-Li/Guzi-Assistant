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

/** 校验并归一化 ISO：格式对 + 真实日历日期（拒 2026-13-45 / 99:99）→ 返回 YYYY-MM-DDTHH:mm，否则 null。 */
function validIso(s: unknown): string | null {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return null
  const iso = s.slice(0, 16)
  const [datePart, timePart] = iso.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [hh, mm] = timePart.split(':').map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null
  const probe = new Date(y, mo - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null
  return iso
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
    const iso = validIso(o.isoTime)
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
      strong: iso !== null
    })
  }
  return out
}

/**
 * OCR 全文切块喂小模型：满屏 UI 噪声会把 1.5B 淹掉（单次易漏检），按行去重后切小块逐块抽。
 * 归一化「自己：/对方：/【…】」前缀去重，消掉聊天转写与屏幕全文的重复。
 * 每块 ≤maxLines 行且 ≤maxChars 字；最多 maxChunks 块（兜住超大屏幕的延迟）。
 */
export function chunkForExtraction(text: string, maxLines = 14, maxChars = 600, maxChunks = 12): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const ln = raw.trim()
    if (!ln) continue
    const norm = ln
      .replace(/^(自己|对方)：/, '')
      .replace(/^【[^】]*】/, '')
      .trim()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    lines.push(ln)
  }
  const chunks: string[] = []
  let cur: string[] = []
  let len = 0
  for (const ln of lines) {
    cur.push(ln)
    len += ln.length
    if (cur.length >= maxLines || len >= maxChars) {
      chunks.push(cur.join('\n'))
      cur = []
      len = 0
      if (chunks.length >= maxChunks) break
    }
  }
  if (cur.length && chunks.length < maxChunks) chunks.push(cur.join('\n'))
  return chunks
}

/** 跨块合并后按 标题+时间 去重。 */
export function dedupeExtractions(items: LocalExtraction[]): LocalExtraction[] {
  const seen = new Set<string>()
  const out: LocalExtraction[] = []
  for (const it of items) {
    const k = `${it.title}|${it.isoTime ?? ''}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(it)
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
  '- isoTime: 事件时间，格式严格 "YYYY-MM-DDTHH:mm"；解析不出具体日期就填 null，绝不编造。注意"下午X点"要 +12（下午三点=15:00、下午2点=14:00），中午12点、晚上以 24 小时制。',
  '- deadline: 是否截止性质（"前交/截止/DDL"）',
  '- belongsToUser: 这件事是不是用户本人的，取 "yes"/"no"/"uncertain"',
  '- hits: 命中的关键信号词数组（如 "组会"/"考试"）',
  '- confidence: 0~1 的置信度',
  '- needsVlm: 信息不全/拿不准、需要更强模型复核时填 true',
  '规则：',
  '- 屏幕上没有任何明确待办时，必须返回空数组 []。',
  '- 不要编造时间或事项；解析不出具体日期时 isoTime 填 null。',
  '- 事件若已取消/已结束/已过去/被否定（如"取消了""不用来了""已结束""已开完"），不要建为待办——返回 [] 或把该项 needsVlm 设为 true。',
  '- 闲聊、表情、玩笑、无明确时间的模糊邀约（如"周末一起吃饭吧"）不算待办。',
  '示例："原定明天的组会取消了，大家不用来了" → []；"明天下午三点开会" → [{"title":"开会","isoTime":"<明天>T15:00","deadline":false,"belongsToUser":"yes","hits":["开会"],"confidence":0.9,"needsVlm":false}]。'
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
