/**
 * 确定性中文日期解析（纯函数）：小模型对「下周一=哪天」这类相对星期推算偏弱，
 * 这里用规则把文本里的相对/显式日期解析成真实年月日，用来纠正模型给的 isoTime 的日期部分。
 * 只解析有把握的常见表达；纯中文数字日期（「六月八号」）等仍交给模型。
 */

// 相对日 / 星期 / X月X日(号) / YYYY-MM-DD / X/X
const DATE_RE =
  /(今天|今日|明天|明日|后天|大后天|(?:下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]|\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*\/\s*\d{1,2})/

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const REL: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 }

const pad = (n: number): string => String(n).padStart(2, '0')

export interface YMD {
  y: number
  mo: number
  d: number
}

/** 把一个日期短语解析为具体年月日；解不出返回 null。绝不编造。 */
function resolveDatePhrase(s: string, now: Date): YMD | null {
  const t = s.replace(/\s/g, '')
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  for (const [k, off] of Object.entries(REL)) {
    if (t.startsWith(k)) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + off)
      return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() }
    }
  }
  const wd = t.match(/^(下下|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天])$/)
  if (wd) {
    const prefix = wd[1]
    const target = WEEKDAY[wd[2]] // 1..7（周一..周日）
    const todayJs = today.getDay() === 0 ? 7 : today.getDay()
    let offset: number
    if (!prefix) {
      offset = (target - todayJs + 7) % 7 // 裸「周X」：本周内最近一次，含今天(0)
    } else {
      const weeks = prefix === '下' ? 1 : prefix === '下下' ? 2 : 0
      offset = -(todayJs - 1) + weeks * 7 + (target - 1) // 本/这/下/下下：按自然周绝对定位
    }
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() }
  }
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    const y = +iso[1]
    const mo = +iso[2]
    const d = +iso[3]
    const probe = new Date(y, mo - 1, d)
    if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null
    return { y, mo, d }
  }
  const md = t.match(/^(\d{1,2})(?:月|\/)(\d{1,2})[日号]?$/)
  if (md) {
    const mo = +md[1]
    const d = +md[2]
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    let y = today.getFullYear()
    if (new Date(y, mo - 1, d) < today) y += 1 // 已过去 → 次年
    return { y, mo, d }
  }
  return null
}

/** 从文本里找第一个可确定性解析的日期，返回年月日；找不到返回 null。 */
export function resolveLocalDate(text: string, now: Date = new Date()): YMD | null {
  const m = DATE_RE.exec(text)
  if (!m) return null
  return resolveDatePhrase(m[1], now)
}

/**
 * 用文本里的确定性日期纠正模型给的 isoTime 的「日期部分」（保留模型的钟点）。
 * - 模型没给时间（null）→ 不动（不臆造）。
 * - 文本解不出确定性日期 → 不动（交给模型，如纯中文数字日期）。
 * - 解出且与模型不一致 → 用确定性日期 + 模型钟点。
 */
export function correctIsoDate(modelIso: string | null, text: string, now: Date = new Date()): string | null {
  if (!modelIso) return modelIso
  const det = resolveLocalDate(text, now)
  if (!det) return modelIso
  const detDate = `${det.y}-${pad(det.mo)}-${pad(det.d)}`
  if (modelIso.slice(0, 10) === detDate) return modelIso
  return `${detDate}T${modelIso.slice(11, 16)}`
}
