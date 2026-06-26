/**
 * 屏幕感知本地小模型的纯逻辑层：grammar JSON schema、模型输出校验/强转、跨块去重、升级判定。
 * 纯函数、零依赖，可离线单测；不 import 任何 electron/native。
 * 注：候选/日期/时间/分类提示词已迁到 screen-foreground.ts（前景+日期锚定管线）。
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

/** 是否需要上云 VLM 复核：模型自判 needsVlm 或本地置信度不足。 */
export function shouldEscalate(e: Pick<LocalExtraction, 'needsVlm' | 'confidence'>, confMin: number): boolean {
  return e.needsVlm || e.confidence < confMin
}
