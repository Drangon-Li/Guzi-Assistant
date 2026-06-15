/**
 * 交互捕获决策（#路线图 2a/2b）：监控敏感按键（回车/空格），用户按回车时把「当前输入内容」
 * 作为被动记忆来源记录下来 —— 但不是每个回车都记。本模块是**纯决策算法**（无 IO、可数据集验证）：
 * 给定一段内容 + 近期已记录状态，判断是否值得记录、为什么。原生全局键钩子（uiohook，跨平台/Win 优先）
 * 只负责把 (按键, 内容) 事件喂进来，记什么/记不记由这里定。
 *
 * 设计取向（不过度）：宁可漏记寒暄/凭据，也别把密码、语气词、重复内容塞进记忆。
 */

export interface RecordDecision {
  record: boolean
  reason: string
}

export interface CaptureState {
  recent: { hash: string; atMs: number }[] // 近期已记录（去重 + 控量）
}

export function newCaptureState(): CaptureState {
  return { recent: [] }
}

const MIN_LEN = 6
const DEDUP_WINDOW_MS = 10 * 60 * 1000
const STATE_TTL_MS = 60 * 60 * 1000

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}
function keyOf(s: string): string {
  return normalize(s).toLowerCase()
}

/** 寒暄/语气词/确认（无信息量，不值得入记忆） */
const CHATTER = /^(哈+|嗯+|哦+|嘿+|呵+|ok|okay|好的?|行|收到|谢谢?|多谢|在吗|嗯呐|了解|可以|没事)[。.!！~、,，]*$/i

/**
 * 凭据样子：无空格、长度 8~64、英文数字符号混合（≥3 类）且不含中文。
 * 防止把密码/token/卡号当作内容记进记忆（与解析层护凭据一致）。
 */
function looksLikeCredential(s: string): boolean {
  if (/\s/.test(s)) return false
  if (s.length < 8 || s.length > 64) return false
  if (/[一-龥]/.test(s)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(s)).length
  return classes >= 3
}

/** 是否有实质文本：含中文，或含连续 2+ 字母的词 */
function hasSubstance(s: string): boolean {
  return /[一-龥]/.test(s) || /[a-zA-Z]{2,}/.test(s)
}

export function shouldRecord(
  content: string,
  state: CaptureState,
  nowMs: number,
  dedupWindowMs: number = DEDUP_WINDOW_MS
): RecordDecision {
  const t = normalize(content)
  if (t.length < MIN_LEN) return { record: false, reason: '太短' }
  if (!hasSubstance(t)) return { record: false, reason: '无实质文本（纯标点/数字/符号）' }
  if (looksLikeCredential(t)) return { record: false, reason: '疑似凭据，保护不记' }
  if (CHATTER.test(t)) return { record: false, reason: '寒暄/语气词' }
  const k = keyOf(t)
  if (state.recent.some((r) => r.hash === k && nowMs - r.atMs < dedupWindowMs))
    return { record: false, reason: '近期已记录（重复）' }
  return { record: true, reason: 'ok' }
}

/** 记录后登记，供去重 + 控量（过期清理 + 上限 200 条） */
export function noteRecorded(content: string, state: CaptureState, nowMs: number): void {
  state.recent.push({ hash: keyOf(content), atMs: nowMs })
  const cutoff = nowMs - STATE_TTL_MS
  state.recent = state.recent.filter((r) => r.atMs >= cutoff).slice(-200)
}
