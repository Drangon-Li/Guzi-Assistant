// 剪贴板自动捕获的省钱/降噪门（在 macOS 的 CalendarEvent 检测之后、上云之前）。
//
// 前三道门（changeCount / Concealed 标记 / detectPatterns）都在原生 helper 和主进程里，
// 全程不读正文；能走到这里的内容已经被读出来了，这里只决定「值不值得花一次云端解析」。
// 纯函数 + 注入 now，便于单测。

export const CLIP_LIMITS = {
  /** 短于此长度不可能是有效事项（「明天」这种） */
  minChars: 4,
  /** 长于此长度多半是整篇文档/代码，不是待办 */
  maxChars: 5000,
  /** 两次自动上云的最小间隔：连续复制时别把积分刷光 */
  minGapMs: 60_000,
  /** 同一内容的冷却时长（与屏幕感知的内容冷却口径一致） */
  cooldownMs: 10 * 60 * 1000,
  /** 超过这个长度就不走本地快路：可能夹带多条事项或大段上下文，交给模型拆 */
  fastMaxChars: 40
} as const

export interface ClipGateInput {
  text: string
  nowMs: number
  /** 该内容 hash 的冷却到期时刻；null = 没冷却过 */
  cooldownUntilMs: number | null
  /** 上次自动上云解析的时刻；null = 从未 */
  lastParseAtMs: number | null
  /** 复制发生时前台 App 是否在排除名单里 */
  excludedApp: boolean
  /** 这次处理是否要调模型。本地快路不花积分，不该被限流拦住。 */
  usesModel: boolean
}

export type ClipGateReason = 'excluded_app' | 'too_short' | 'too_long' | 'cooldown' | 'rate_limited'
export type ClipGateDecision = { run: true } | { run: false; reason: ClipGateReason }

/** 是否值得为这段剪贴板文本花一次云端解析。手动 Alt+C 不走这里——显式意图无条件放行。 */
export function decideClipboardParse(input: ClipGateInput): ClipGateDecision {
  // 隐私门排在最前：排除名单里的 App 复制出来的东西，一概不上云
  if (input.excludedApp) return { run: false, reason: 'excluded_app' }

  const length = input.text.trim().length
  if (length < CLIP_LIMITS.minChars) return { run: false, reason: 'too_short' }
  if (length > CLIP_LIMITS.maxChars) return { run: false, reason: 'too_long' }

  if (input.cooldownUntilMs != null && input.nowMs < input.cooldownUntilMs)
    return { run: false, reason: 'cooldown' }
  // 限流只为控制云端花费；本地快路不花钱，连续复制也该条条响应
  if (
    input.usesModel &&
    input.lastParseAtMs != null &&
    input.nowMs - input.lastParseAtMs < CLIP_LIMITS.minGapMs
  )
    return { run: false, reason: 'rate_limited' }

  return { run: true }
}

export interface ClipFastInput {
  text: string
  /** DDMatchCalendarEvent 解出的本地起始时刻；解不出时为空 */
  startIso?: string | null
  endIso?: string | null
  allDay?: boolean
  nowMs: number
}

export type ClipFastDecision =
  | { fast: true; title: string; isoTime: string; deadline: boolean }
  | { fast: false; reason: 'no_local_time' | 'multiline' | 'too_complex' | 'past_time' }

/**
 * 能不能不调模型就把这条剪贴板变成一个待办。
 *
 * 时间由 macOS 的 DataDetectors 给出（已实测中文准确），标题直接用复制的原文——
 * 用户主动复制的短句，原文本身就是最好的标题，让模型再润色一遍不值 8 秒。
 * 判不准的（多行、太长、没解出时间）一律回落到模型，不硬猜。
 *
 * 注意：这里不重新发明「关键词 + 正则」的本地抽取。那套在
 * docs/superpowers/specs/2026-06-25-screen-sense-local-model-design.md 里有记录，
 * 因「漏检/错检严重」被删除过一次。
 */
export function decideClipboardFastPath(input: ClipFastInput): ClipFastDecision {
  if (!input.startIso) return { fast: false, reason: 'no_local_time' }
  const title = input.text.trim()
  if (/[\r\n]/.test(title)) return { fast: false, reason: 'multiline' }
  if (title.length > CLIP_LIMITS.fastMaxChars) return { fast: false, reason: 'too_complex' }

  // 全天 → 按截止处理，并归到当日 23:59：
  // 检测器给的是当天中午，「周五前交」会在周五下午就被标成逾期。
  const deadline = !!input.allDay
  const isoTime = deadline ? `${input.startIso.slice(0, 10)}T23:59` : input.startIso

  // 检测器认出「上午十点」却没认出「下月三号」时，会默默用今天补齐日期，
  // 产出一个自信的错误（实测「下月三号上午十点」→ 今天 10:00）。
  // 特征就是解出的时刻落在过去——这种交给模型重判，宁可慢几秒也不能记错日子。
  const parsed = Date.parse(isoTime)
  if (!Number.isFinite(parsed) || parsed < input.nowMs) return { fast: false, reason: 'past_time' }

  return { fast: true, title, isoTime, deadline }
}
