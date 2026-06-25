/**
 * 本地优先的日程粗检测（屏幕感知 v2）——纯函数、离线、零依赖。
 *
 * 目标:不上云就在本地做一次"严格"判断,延迟≈0。命中才弹精简卡;真要精确再点「AI 解析」。
 * 严格门 = 同时满足:① 命中关键词 ② 文本里有明确的时间/日期线索。两者缺一返回 null。
 *
 * 时间解析是"尽力而为(best-effort)":能解出的常见中文/数字表达给出 ISO，解不出就留原文(isoTime=null)，
 * 交给 AI 精修。绝不编造日期。
 *
 * 自包含(无运行时依赖):关键词匹配内联，便于离线单测与跨进程复用。
 */

/** 返回 text 中命中的关键词(去重、大小写不敏感)。与 @shared/keywords.matchKeywords 同义。 */
function hitKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  for (const kw of keywords) {
    const k = kw.trim()
    if (k && lower.includes(k.toLowerCase()) && !out.includes(k)) out.push(k)
  }
  return out
}

export interface LocalSchedule {
  /** 粗标题:命中时间/关键词的那一行原文 */
  title: string
  /** 命中的时间原文(如「周四下午三点」) */
  timeText: string
  /** 尽力解析出的本地时间 YYYY-MM-DDTHH:mm;解不出为 null */
  isoTime: string | null
  /** 命中的关键词 */
  hits: string[]
  /** 强信号:解析出了具体日期(而非仅钟点)——决定是否"主动弹窗"，弱信号只留历史 */
  strong: boolean
  /** 是否截止语气(截止/DDL/前交):同意时填 dueTime，否则填 startTime */
  deadline: boolean
}

// 日期线索:相对日 / 星期 / X月X日(号) / YYYY-MM-DD / X月X / X/X
const DATE_RE =
  /(今天|今日|明天|明日|后天|大后天|(?:下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]|\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*\/\s*\d{1,2})/
// 钟点:HH:MM / (上午下午…)X点(半|X分);X 支持阿拉伯或中文(三点/十一点)
const CLOCK_RE =
  /((?:上午|下午|中午|晚上|凌晨)?\s*\d{1,2}\s*[:：]\s*\d{2}|(?:上午|下午|中午|晚上|凌晨)?\s*(?:\d{1,2}|十[一二]?|[一两二三四五六七八九])\s*点(?:\s*半|\s*\d{1,2}\s*分)?)/
const CN_HOUR: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12
}
// 截止语气:无具体钟点时,日期落到 23:59
const DEADLINE_RE = /(截止|deadline|ddl|前\s*(?:交|提交|完成|交付|报名|缴费))/i

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const REL: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 }

const pad = (n: number): string => String(n).padStart(2, '0')

interface YMD {
  y: number
  mo: number
  d: number
}

/** 把日期线索解析为具体年月日;解不出返回 null。绝不编造。 */
function resolveDate(s: string, now: Date): YMD | null {
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
    const target = WEEKDAY[wd[2]] // 1..7 (周一..周日)
    const todayJs = today.getDay() === 0 ? 7 : today.getDay()
    let offset: number
    if (!prefix) {
      offset = (target - todayJs + 7) % 7 // 裸「周X」：本周内最近一次，含今天(0)
    } else {
      // 本/这/下/下下：按自然周(周一为首)绝对定位，避免「下周一」落到本周
      const weeks = prefix === '下' ? 1 : prefix === '下下' ? 2 : 0
      offset = -(todayJs - 1) + weeks * 7 + (target - 1)
    }
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() }
  }
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    const y = +iso[1]
    const mo = +iso[2]
    const d = +iso[3]
    // 校验真实日历日期，拒绝 2026-13-45 / 2026-02-30 之类（否则会拼出非法 isoTime）
    const probe = new Date(y, mo - 1, d)
    if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null
    return { y, mo, d }
  }
  // X月X日(号) 或 X/X —— 用当年;若已过去则次年
  const md = t.match(/^(\d{1,2})(?:月|\/)(\d{1,2})[日号]?$/)
  if (md) {
    const mo = +md[1]
    const d = +md[2]
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    let y = today.getFullYear()
    if (new Date(y, mo - 1, d) < today) y += 1
    return { y, mo, d }
  }
  return null
}

/** 把钟点线索解析为 [时, 分];解不出返回 null */
function resolveClock(s: string): [number, number] | null {
  const t = s.replace(/\s/g, '')
  const pm = /下午|晚上/.test(t)
  const noon = /中午/.test(t)
  const hm = t.match(/(\d{1,2})[:：](\d{2})/)
  if (hm) {
    let hh = +hm[1]
    if (pm && hh < 12) hh += 12
    return [Math.min(23, hh), Math.min(59, +hm[2])]
  }
  const dot = t.match(/(\d{1,2}|十[一二]?|[一两二三四五六七八九])\s*点(?:(半)|(\d{1,2})\s*分)?/)
  if (dot) {
    let hh = /^\d+$/.test(dot[1]) ? +dot[1] : (CN_HOUR[dot[1]] ?? NaN)
    if (Number.isNaN(hh)) return null
    if (noon) hh = 12
    else if (pm && hh < 12) hh += 12
    const mm = dot[2] ? 30 : dot[3] ? Math.min(59, +dot[3]) : 0
    return [Math.min(23, hh), mm]
  }
  return null
}

/** 取命中位置所在的整行作为粗标题,清掉多余空白、截断过长 */
function lineAround(text: string, idx: number): string {
  const start = text.lastIndexOf('\n', idx) + 1
  let end = text.indexOf('\n', idx)
  if (end < 0) end = text.length
  return text.slice(start, end).trim().replace(/\s+/g, ' ').slice(0, 60)
}

export function detectLocalSchedule(
  text: string,
  keywords: string[],
  now: Date = new Date()
): LocalSchedule | null {
  if (!text) return null
  const hits = hitKeywords(text, keywords)
  if (!hits.length) return null // 门①:无关键词

  const dateM = DATE_RE.exec(text)
  const clockM = CLOCK_RE.exec(text)
  if (!dateM && !clockM) return null // 门②:无任何时间线索

  const ymd = dateM ? resolveDate(dateM[1], now) : null
  const hm = clockM ? resolveClock(clockM[1]) : null

  let isoTime: string | null = null
  if (ymd) {
    const [hh, mm] = hm ?? (DEADLINE_RE.test(text) ? [23, 59] : [9, 0])
    isoTime = `${ymd.y}-${pad(ymd.mo)}-${pad(ymd.d)}T${pad(hh)}:${pad(mm)}`
  } else if (hm) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    isoTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hm[0])}:${pad(hm[1])}`
  }

  const timeText = [dateM?.[1], clockM?.[1]].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  const anchor = dateM ?? clockM!
  const title = lineAround(text, anchor.index)

  // 强信号 = 解析出了具体日期(不只是钟点)。仅钟点容易是噪声 → 弱信号,只进历史不主动弹。
  const strong = ymd !== null

  return { title: title || timeText, timeText, isoTime, hits, strong, deadline: DEADLINE_RE.test(text) }
}
