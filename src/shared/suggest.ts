import type { ParsedItem } from './parsing'

/** 低于此置信度不出建议（宁漏勿误，对齐 Apple HIG） */
export const SUGGEST_MIN_CONFIDENCE = 0.4

/** 从解析出的事项里挑最可能作为单条建议的一项；没有合适的返回 null */
export function pickBest(items: ParsedItem[]): ParsedItem | null {
  const candidates = items.filter((i) => i.belongs_to_user !== 'no')
  if (!candidates.length) return null
  const score = (i: ParsedItem): number =>
    (i.belongs_to_user === 'yes' ? 2 : i.belongs_to_user === 'uncertain' ? 1 : 0) * 1000 +
    i.confidence * 100 +
    (i.start_time || i.due_time ? 1 : 0)
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a))
  return best.confidence >= SUGGEST_MIN_CONFIDENCE ? best : null
}
