/**
 * 屏幕感知「前景 + 日期锚定」纯逻辑层。配合 OCR 框坐标，把满屏 OCR 收敛成少量高信噪候选：
 * 1) 前景过滤：按归一化坐标剔除左侧栏/会话列表 + 顶部菜单栏，只留当前阅读主体。
 * 2) 日期锚定候选：扫「含日期 + 事件关键词」的行，成小窗口；负例无候选 → 直接空、且快。
 * 3) 确定性日期/时间：相对日(明天/下周X)优先、区间取末日、时间绑定到行内，避免取到邻行时间戳。
 * 纯函数、零 electron/native 依赖，可离线单测。模型只负责「这段是不是待办 + 标题 + 归属」。
 */
import type { TextBox } from './chat-layout'
import type { LocalExtraction } from './types'

const FG_X_CUT = 0.18 // 左侧 18% 视为导航/会话列表/侧栏
const FG_Y_TOP = 0.025 // 顶部 2.5% 视为系统菜单栏/时钟
const MAX_CANDIDATES = 12

export interface ForegroundBand {
  text: string
  /** 该带的上边缘 y（归一化）；供候选关联其上方最近的聊天时间戳。 */
  y: number
}

/** 前景文字带：剔除左侧栏(x<cut) + 菜单栏(y<top)，按阅读顺序(y 分带→带内按 x)重排，每带带上 y。 */
export function foregroundBands(boxes: TextBox[], xCut = FG_X_CUT, yTop = FG_Y_TOP): ForegroundBand[] {
  const fg = boxes.filter((b) => b.x >= xCut && b.y >= yTop)
  const bands = new Map<number, TextBox[]>()
  for (const b of fg) {
    const k = Math.round(b.y / 0.012)
    const arr = bands.get(k)
    if (arr) arr.push(b)
    else bands.set(k, [b])
  }
  return [...bands.keys()]
    .sort((a, b) => a - b)
    .map((k) => {
      const arr = bands.get(k)!.sort((p, q) => p.x - q.x)
      return { text: arr.map((i) => i.text).join('  '), y: Math.min(...arr.map((i) => i.y)) }
    })
}

/** 前景文字行（纯文本，向后兼容）。 */
export function foregroundLines(boxes: TextBox[], xCut = FG_X_CUT, yTop = FG_Y_TOP): string[] {
  return foregroundBands(boxes, xCut, yTop).map((b) => b.text)
}

// ---------- 确定性日期/时间 ----------

const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const pad = (n: number): string => String(n).padStart(2, '0')

function cnHour(s: string): number | null {
  if (/^\d+$/.test(s)) return +s
  if (s.length === 1) return CN[s] ?? null
  if (s[0] === '十') return 10 + (CN[s[1]] ?? 0)
  return null
}

/** 从一段文本解析钟点；解不出返回 null。"下午X点"+12、X点半=:30。 */
export function parseTimeOfDay(text: string): { hh: number; mm: number } | null {
  const t = text.replace(/\s/g, '')
  let m = t.match(/(\d{1,2})[:：](\d{2})/)
  if (m && +m[1] < 24 && +m[2] < 60) return { hh: +m[1], mm: +m[2] }
  m = t.match(/(上午|早上|凌晨|中午|下午|晚上|傍晚|夜里)?(\d{1,2}|十[一二]?|[一二两三四五六七八九])[点时](半|\d{1,2}分|[一二三四五六七八九十]+分)?/)
  if (!m) return /中午/.test(t) ? { hh: 12, mm: 0 } : null
  let hh = cnHour(m[2])
  if (hh == null) return null
  const p = m[1]
  if ((p === '下午' || p === '晚上' || p === '傍晚' || p === '夜里') && hh < 12) hh += 12
  else if (p === '中午') hh = 12
  let mm = 0
  const suf = m[3]
  if (suf === '半') mm = 30
  else if (suf) {
    const dm = suf.match(/(\d{1,2})分/)
    if (dm) mm = +dm[1]
    else {
      const cm = suf.match(/([一二三四五六七八九十]+)分/)
      if (cm) mm = cnHour(cm[1]) ?? 0
    }
  }
  return hh < 24 && mm < 60 ? { hh, mm } : null
}

interface YMD {
  y: number
  mo: number
  d: number
}

const REL: Record<string, number> = { 今天: 0, 今日: 0, 今晚: 0, 明天: 1, 明日: 1, 明晚: 1, 后天: 2, 大后天: 3, 昨天: -1, 前天: -2 }
const WD: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

/** 仅认明确相对词(明天/今天/后天…)，不认裸周X。 */
export function relWordDate(text: string, now: Date): YMD | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (const [k, off] of Object.entries(REL)) {
    if (text.includes(k)) {
      const x = new Date(today.getFullYear(), today.getMonth(), today.getDate() + off)
      return { y: x.getFullYear(), mo: x.getMonth() + 1, d: x.getDate() }
    }
  }
  return null
}

/** 裸「周X/星期X」→ 最近一次(本周内含今天)；带「下/下下/本/这」按自然周定位。 */
export function weekdayDate(text: string, now: Date): YMD | null {
  const w = text.match(/(下下|下|本|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/)
  if (!w) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = WD[w[2]]
  const todayJs = today.getDay() === 0 ? 7 : today.getDay()
  const weeks = w[1] === '下' ? 1 : w[1] === '下下' ? 2 : 0
  const off = w[1] ? -(todayJs - 1) + weeks * 7 + (target - 1) : (target - todayJs + 7) % 7
  const x = new Date(today.getFullYear(), today.getMonth(), today.getDate() + off)
  return { y: x.getFullYear(), mo: x.getMonth() + 1, d: x.getDate() }
}

const ABS_G = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})|(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g

const WD_RE = /(下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]/

/** 窗口里「日期短语」起始下标：相对词 → 绝对日(取末) → 周X；都没有返回 -1。时间从此处起算，避开前面的聊天时间戳。 */
function dateAnchorIndex(window: string): number {
  let best = -1
  for (const k of Object.keys(REL)) {
    const i = window.indexOf(k)
    if (i >= 0 && (best < 0 || i < best)) best = i
  }
  if (best >= 0) return best
  const ms = [...window.matchAll(ABS_G)]
  if (ms.length) return ms[ms.length - 1].index ?? 0
  const wd = window.match(WD_RE)
  return wd?.index ?? -1
}

/**
 * 窗口内确定性 isoTime：相对词优先；否则取「最后一个」绝对日期(区间/截止取末)；
 * 时间**只从日期短语起算**(window.slice(anchor))——避免抓到日期前面别行的聊天时间戳(#2 时间二次错)。
 * 绝对「X月X日」不做 +1 年(「有日程就算」约定下过去日期照常)。解不出返回 null。
 */
export function combineDet(window: string, now: Date): string | null {
  let date = relWordDate(window, now)
  if (!date) {
    const ms = [...window.matchAll(ABS_G)]
    if (ms.length) {
      const m = ms[ms.length - 1]
      date = m[1] ? { y: +m[1], mo: +m[2], d: +m[3] } : { y: now.getFullYear(), mo: +m[4], d: +m[5] }
    } else {
      date = weekdayDate(window, now)
    }
  }
  if (!date) return null
  const ds = `${date.y}-${pad(date.mo)}-${pad(date.d)}`
  const anchor = dateAnchorIndex(window)
  const tm = parseTimeOfDay(anchor >= 0 ? window.slice(anchor) : window)
  return tm ? `${ds}T${pad(tm.hh)}:${pad(tm.mm)}` : `${ds}T00:00`
}

// ---------- 候选窗口 ----------

const DATE_LINE_RE =
  /(今天|今日|明天|明日|后天|大后天|今晚|明晚|昨天|前天|(?:下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]|\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号])/
/** 事件关键词：窗口须含其一才成候选 → 滤掉邮件 header/列表纯日期等噪声(提速 + 改善排序)。
 *  含截止/完成类动词("X点之前完成…"这类 deadline 任务此前漏检 → 补 完成/做完/交付/上交 等)。 */
const EVENT_KW =
  /会议|例会|周会|班会|组会|开.{0,2}会|约.{0,2}会|课程|上课|选课|考试|笔试|面试|答辩|考核|开题|活动|讲座|报名|截止|提交|完成|做完|搞定|弄好|交付|上交|递交|发给|培训|签到|预约|面谈|deadline|ddl|review|sync|weekly|meeting/i

export interface CandidateWindow {
  /** 窄窗(前1行+本行)：喂确定性日期解析，保证日期关联准 */
  detW: string
  /** 喂模型分类(同窄窗)；事件词检测用更宽上下文 */
  modelW: string
  /** 日期所在行在 foregroundBands 中的下标，供关联其上方聊天时间戳判消息新旧(#2)。 */
  lineIndex: number
}

/** 扫含日期且含事件词的行成候选；事件词在「前2行」宽上下文里命中即可(救标题在上行的情形)。 */
export function candidateWindows(lines: string[]): CandidateWindow[] {
  const wins: CandidateWindow[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    if (!DATE_LINE_RE.test(lines[i])) continue
    const w = [lines[i - 1] || '', lines[i]].join(' ').trim()
    const kwCtx = [lines[i - 2] || '', lines[i - 1] || '', lines[i]].join(' ')
    if (seen.has(w) || !EVENT_KW.test(kwCtx)) continue
    seen.add(w)
    wins.push({ detW: w, modelW: w, lineIndex: i })
    if (wins.length >= MAX_CANDIDATES) break
  }
  return wins
}

// ---------- 聊天消息时间：判新旧(#2) ----------
// 思路：聊天「时间戳/系统分隔」行是居中的(气泡里的消息文字靠左/右)，据此从 OCR 框里挑出时间戳，
// 解析其「发送日期」。候选关联到其上方最近的时间戳 → 非今天(昨天及更早)视为旧消息：大概率已处理。

const TS_CENTER_LO = 0.35 // 居中行：行中心 x 在 [0.35,0.65] 视为时间戳/系统分隔
const TS_CENTER_HI = 0.65
// 非居中但含「明确日历日期」的行(如「06月25日 21:08」)也认作时间戳：部分 IM 时间戳靠左/靠右，
// 居中判定会漏；消息气泡几乎不会是纯「X月X日 HH:MM」，误判风险低(纯时刻行仍要求居中)。
const ABS_DATE_RE = /\d{4}\s*[-/年]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]/

/** 解析聊天时间戳行的「发送日期」→ YYYY-MM-DD。须含具体时刻才算时间戳行；无日期词默认今天。否则 null。 */
export function chatSentDateKey(text: string, now: Date): string | null {
  const t = text.trim()
  if (!t || t.length > 24) return null // 时间戳行通常很短
  if (!parseTimeOfDay(t) && !/\d{1,2}[:：]\d{2}/.test(t)) return null // 必须像个时刻
  let date = relWordDate(t, now) // 今天/昨天/前天
  if (!date) {
    const ms = [...t.matchAll(ABS_G)]
    if (ms.length) {
      const m = ms[0]
      date = m[1] ? { y: +m[1], mo: +m[2], d: +m[3] } : { y: now.getFullYear(), mo: +m[4], d: +m[5] }
    } else {
      date = weekdayDate(t, now)
    }
  }
  if (!date) date = { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() } // 纯时刻=今天
  return `${date.y}-${pad(date.mo)}-${pad(date.d)}`
}

/** 从 OCR 框取「聊天时间戳」→ {y, dateKey}，按 y 升序。居中行全认；非居中行须含明确日历日期。 */
export function messageTimestamps(boxes: TextBox[], now: Date): { y: number; dateKey: string }[] {
  const out: { y: number; dateKey: string }[] = []
  for (const b of boxes) {
    const dateKey = chatSentDateKey(b.text, now)
    if (!dateKey) continue
    const cx = b.x + b.w / 2
    const centered = cx >= TS_CENTER_LO && cx <= TS_CENTER_HI
    if (!centered && !ABS_DATE_RE.test(b.text)) continue // 非居中仅认带明确日期的分隔行
    out.push({ y: b.y, dateKey })
  }
  return out.sort((a, b) => a.y - b.y)
}

/** 候选(在 candidateY 处)上方最近时间戳的 dateKey；无→null。 */
function nearestTimestampKey(candidateY: number, timestamps: { y: number; dateKey: string }[]): string | null {
  let nearest: string | null = null
  for (const ts of timestamps) {
    if (ts.y <= candidateY) nearest = ts.dateKey
    else break // 升序，第一个在候选下方的之后都更下方
  }
  return nearest
}

/** 候选(在 candidateY 处)上方最近时间戳是否「非今天」→ 旧消息。无时间戳→false(照常处理)。 */
export function isStaleMessage(
  candidateY: number,
  timestamps: { y: number; dateKey: string }[],
  now: Date
): boolean {
  const nearest = nearestTimestampKey(candidateY, timestamps)
  if (!nearest) return false
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return nearest !== today
}

/**
 * 候选上方最近聊天时间戳的「发送日期」→ Date(当地零点)；无时间戳返回 null。
 * 供把相对日期(明天/后天/下周X)锚定到「消息发送日」而非「今天」(#2)：
 * 几天前发的「明天六点开会」，应算消息发送日的次日，而非今天的次日。
 */
export function sentDateAnchor(
  candidateY: number,
  timestamps: { y: number; dateKey: string }[]
): Date | null {
  const key = nearestTimestampKey(candidateY, timestamps)
  if (!key) return null
  const [y, mo, d] = key.split('-').map(Number)
  return new Date(y, mo - 1, d)
}

// ---------- 选优 ----------

const hasTime = (iso: string | null): boolean => !!iso && iso.slice(11, 16) !== '00:00'

/** 选优：优先「有具体时间」的候选(邮件列表是 T00:00 纯日期，真实事件多带时间)，再比 strong/置信。 */
export function pickBestByTime(items: LocalExtraction[]): LocalExtraction | null {
  if (!items.length) return null
  return [...items].sort(
    (a, b) =>
      Number(hasTime(b.isoTime)) - Number(hasTime(a.isoTime)) ||
      Number(b.strong) - Number(a.strong) ||
      b.confidence - a.confidence
  )[0]
}

/**
 * 多候选歧义：≥2 个 strong 候选且「日期」彼此不一致 → 本地难判哪个是前景事件(密集学术邮件
 * 「列表收件日期」压「正文事件日期」=#2/#3 的真实极限)。此时即便本地置信高也强制升级 VLM 兜底。
 */
export function isAmbiguous(items: LocalExtraction[]): boolean {
  const dates = new Set<string>()
  for (const it of items) if (it.strong && it.isoTime) dates.add(it.isoTime.slice(0, 10))
  return dates.size >= 2
}

// ---------- 分类提示词 ----------

/** 逐候选分类系统提示词：只判「是不是用户具体待办 + 标题 + 归属」，日期时间由外部确定性补正。 */
export const CLASSIFY_SYSTEM_PROMPT = [
  '你是日程判别器。下面给你一小段屏幕文字（通常含一个日期/时间）。判断它是不是"用户需要去做/参加/截止"的具体待办。',
  '是 → 输出 JSON 数组含一个元素：title / isoTime(可填null,外部会补) / deadline / belongsToUser / hits / confidence / needsVlm。',
  '不是 → 输出 []。',
  '要抽：会议/课程/考试/答辩/活动/讲座/选课/报名/截止/提交等，且写明了时间。即使时间已过去也照样抽。',
  '不要抽（返回[]）：纯系统时钟/菜单栏、历史新闻报道、只有日期没有事件的列表项、疑问/讨论/操作指南、闲聊表情、"我觉得/感觉可以"这类个人看法。',
  'belongsToUser: 群发/@全体成员且与用户相关→yes 或 uncertain；明显是别人的事→no。',
  '示例："【A类活动预告】时间：6月28日14:00" → [{"title":"A类活动·讲座","isoTime":null,"deadline":false,"belongsToUser":"uncertain","hits":["活动预告"],"confidence":0.8,"needsVlm":false}]',
  '"明天下午六点来c9872找我开会" → [{"title":"去c9872开会","isoTime":null,"deadline":false,"belongsToUser":"yes","hits":["开会"],"confidence":0.9,"needsVlm":false}]',
  '"@全体成员 明天下午九点半开组会" → [{"title":"开组会","isoTime":null,"deadline":false,"belongsToUser":"yes","hits":["组会"],"confidence":0.85,"needsVlm":false}]',
  '"6月25日 周四 下午9:05" → []；"◎5月22日 培养部学生培养" → []'
].join('\n')

/** 逐候选用户消息：自称(供归属) + 校正记忆 few-shot(Phase 2) + 待判文字。 */
export function buildClassifyPrompt(window: string, selfNames?: string[], fewShot?: string): string {
  const self = selfNames?.filter(Boolean).length ? `用户本人常用称呼：${selfNames.join('、')}。\n` : ''
  const shots = fewShot ? `参考你过去在相似内容上被云端纠正的正确判断：\n${fewShot}\n\n` : ''
  return `${self}${shots}判断下面这段是否用户的具体待办，是就抽一个，不是返回 []：\n"""\n${window.slice(0, 400)}\n"""`
}
