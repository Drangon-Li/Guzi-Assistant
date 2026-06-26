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

/** 前景文字：剔除左侧栏(x<cut) + 菜单栏(y<top)，按阅读顺序(y 分带→带内按 x)重排成多行。 */
export function foregroundLines(boxes: TextBox[], xCut = FG_X_CUT, yTop = FG_Y_TOP): string[] {
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
    .map((k) =>
      bands
        .get(k)!
        .sort((p, q) => p.x - q.x)
        .map((i) => i.text)
        .join('  ')
    )
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

/**
 * 窗口内确定性 isoTime：相对词优先；否则取「最后一个」绝对日期(区间/截止取末)；时间从窗口取。
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
  const tm = parseTimeOfDay(window)
  return tm ? `${ds}T${pad(tm.hh)}:${pad(tm.mm)}` : `${ds}T00:00`
}

// ---------- 候选窗口 ----------

const DATE_LINE_RE =
  /(今天|今日|明天|明日|后天|大后天|今晚|明晚|昨天|前天|(?:下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]|\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号])/
/** 事件关键词：窗口须含其一才成候选 → 滤掉邮件 header/列表纯日期等噪声(提速 + 改善排序)。 */
const EVENT_KW =
  /会议|例会|周会|班会|组会|开.{0,2}会|约.{0,2}会|课程|上课|选课|考试|笔试|面试|答辩|考核|开题|活动|讲座|报名|截止|提交|培训|签到|预约|面谈|deadline|ddl|review|sync|weekly|meeting/i

export interface CandidateWindow {
  /** 窄窗(前1行+本行)：喂确定性日期解析，保证日期关联准 */
  detW: string
  /** 喂模型分类(同窄窗)；事件词检测用更宽上下文 */
  modelW: string
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
    wins.push({ detW: w, modelW: w })
    if (wins.length >= MAX_CANDIDATES) break
  }
  return wins
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

/** 逐候选用户消息：自称(供归属) + 待判文字。 */
export function buildClassifyPrompt(window: string, selfNames?: string[]): string {
  const self = selfNames?.filter(Boolean).length ? `用户本人常用称呼：${selfNames.join('、')}。\n` : ''
  return `${self}判断下面这段是否用户的具体待办，是就抽一个，不是返回 []：\n"""\n${window.slice(0, 400)}\n"""`
}
