// 解析/对话模型的接口格式适配。
//
// 内部一律用 OpenAI Responses 的形状描述请求（历史原因：这套先落地），
// 出网前按用户选的格式翻译一次。加这层的直接原因有两个：
//  1. 多数号称「OpenAI 兼容」的第三方网关只实现了 /v1/chat/completions，
//     没有 /v1/responses——填了地址却一直 404，是最难自查的一类问题；
//  2. Anthropic 走的是另一套（x-api-key 头、system 独立字段、图片要拆 base64）。

export type ApiFormat = 'openai-responses' | 'openai-chat' | 'anthropic'

export const API_FORMATS: { value: ApiFormat; label: string; hint: string }[] = [
  {
    value: 'openai-responses',
    label: 'OpenAI Responses',
    hint: 'OpenAI 官方 /v1/responses。支持 reasoning 参数'
  },
  {
    value: 'openai-chat',
    label: 'OpenAI 兼容 (Chat)',
    hint: '/v1/chat/completions。大多数第三方网关、本地模型用这个'
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: '/v1/messages。Claude 官方接口'
  }
]

export function normalizeApiFormat(v: unknown): ApiFormat {
  return v === 'openai-chat' || v === 'anthropic' ? v : 'openai-responses'
}

/** Anthropic 的接口版本头。写死一个已知可用的版本，别跟着日期漂。 */
export const ANTHROPIC_VERSION = '2023-06-01'
/** Anthropic 必须显式给 max_tokens，OpenAI 那两套不给就是模型上限。 */
export const ANTHROPIC_MAX_TOKENS = 8192

const trimBase = (apiBase: string): string => apiBase.trim().replace(/\/+$/, '')

/** base 已经带 /v1（或 /v2…）就不再补一层，否则拼出 /v1/v1。 */
function withVersion(apiBase: string): string {
  const base = trimBase(apiBase)
  return /\/v\d+$/.test(base) ? base : `${base}/v1`
}

export function chatEndpoint(apiBase: string, format: ApiFormat): string {
  const base = withVersion(apiBase)
  if (format === 'anthropic') return `${base}/messages`
  if (format === 'openai-chat') return `${base}/chat/completions`
  return `${base}/responses`
}

export function chatHeaders(apiKey: string, format: ApiFormat): Record<string, string> {
  const key = apiKey.trim()
  if (format === 'anthropic') {
    return {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json'
    }
  }
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

// ---------- 请求体 ----------

/** 内部规范形状：Responses 的 input 数组。 */
export interface CanonicalPart {
  type: string
  text?: string
  image_url?: string
}
export interface CanonicalMessage {
  role: string
  content: CanonicalPart[] | string
}

const partsOf = (content: CanonicalMessage['content']): CanonicalPart[] =>
  typeof content === 'string' ? [{ type: 'input_text', text: content }] : (content ?? [])

const isImage = (p: CanonicalPart): boolean => p.type === 'input_image' && !!p.image_url

/** data:image/png;base64,XXXX → { media_type, data }；不是 data URL 时返回 null。 */
export function splitDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url.trim())
  return m ? { mediaType: m[1], data: m[2] } : null
}

function toChatMessages(instructions: string, input: CanonicalMessage[]): unknown[] {
  const messages: unknown[] = [{ role: 'system', content: instructions }]
  for (const msg of input) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    const parts = partsOf(msg.content)
    const converted = parts.map((p) =>
      isImage(p)
        ? { type: 'image_url', image_url: { url: p.image_url } }
        : { type: 'text', text: p.text ?? '' }
    )
    // 纯文本单段就退化成字符串：一些简易网关不接受数组形式的 content
    const onlyText = converted.every((c) => (c as { type: string }).type === 'text')
    messages.push({
      role,
      content: onlyText ? parts.map((p) => p.text ?? '').join('\n') : converted
    })
  }
  return messages
}

function toAnthropicMessages(input: CanonicalMessage[]): unknown[] {
  const messages: { role: string; content: unknown[] }[] = []
  for (const msg of input) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    const content = partsOf(msg.content)
      .map((p) => {
        if (!isImage(p)) return { type: 'text', text: p.text ?? '' }
        const img = splitDataUrl(p.image_url ?? '')
        // 拆不出 base64（比如是个 http 链接）就丢掉这一段：Anthropic 不收远程 URL，
        // 硬塞会整条请求 400，丢掉至少文字部分还能解析
        return img
          ? { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }
          : null
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
    if (!content.length) continue
    // 同角色相邻要合并：Anthropic 要求 user/assistant 严格交替
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content.push(...content)
    else messages.push({ role, content })
  }
  // 首条必须是 user；历史以 assistant 开头时把它掐掉
  while (messages.length && messages[0].role !== 'user') messages.shift()
  return messages
}

export interface ChatBodyInput {
  model: string
  instructions: string
  input: CanonicalMessage[]
  /** 仅 openai-responses 用得上；另两套忽略 */
  effort?: 'none' | 'low'
}

export function chatBody(req: ChatBodyInput, format: ApiFormat): Record<string, unknown> {
  if (format === 'anthropic') {
    return {
      model: req.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: req.instructions,
      messages: toAnthropicMessages(req.input)
    }
  }
  if (format === 'openai-chat') {
    return { model: req.model, messages: toChatMessages(req.instructions, req.input) }
  }
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.instructions,
    input: req.input
  }
  if (req.effort) body.reasoning = { effort: req.effort }
  return body
}

// ---------- 响应解析 ----------

interface ChatCompletionShape {
  choices?: { message?: { content?: unknown } }[]
}
interface AnthropicShape {
  content?: { type?: string; text?: string }[]
}
interface ResponsesShape {
  output_text?: string
  output?: { type: string; content?: { type: string; text?: string }[] }[]
}

/** 从各家响应里取出纯文本。取不到返回空串，调用方按「模型没给内容」处理。 */
export function chatText(data: unknown, format: ApiFormat): string {
  if (!data || typeof data !== 'object') return ''
  if (format === 'anthropic') {
    const parts = (data as AnthropicShape).content ?? []
    return parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text as string)
      .join('\n')
  }
  if (format === 'openai-chat') {
    const content = (data as ChatCompletionShape).choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    // 少数网关把 content 也返回成分段数组
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? '')))
        .join('')
    }
    return ''
  }
  const res = data as ResponsesShape
  if (typeof res.output_text === 'string' && res.output_text) return res.output_text
  const parts: string[] = []
  for (const item of res.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) parts.push(c.text)
  }
  return parts.join('\n')
}

/** 各家错误体的 message 字段位置不同，统一取一次。 */
export function chatError(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const err = (data as { error?: unknown }).error
  if (!err) return null
  if (typeof err === 'string') return err
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' ? message : null
}
