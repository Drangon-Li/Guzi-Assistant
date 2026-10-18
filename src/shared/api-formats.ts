// 解析/对话模型的接口格式适配。
//
// 内部一律用 OpenAI Responses 的形状描述请求（历史原因：这套先落地），
// 出网前按识别到或手动指定的格式翻译一次。加这层的直接原因有两个：
//  1. 多数号称「OpenAI 兼容」的第三方网关只实现了 /v1/chat/completions，
//     没有 /v1/responses——填了地址却一直 404，是最难自查的一类问题；
//  2. Anthropic 走的是另一套（x-api-key 头、system 独立字段、图片要拆 base64）。

export type ConcreteApiFormat = 'openai-responses' | 'openai-chat' | 'anthropic'
export type ApiFormat = 'auto' | ConcreteApiFormat

export const API_FORMATS: { value: ApiFormat; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: '自动识别（推荐）',
    hint: '根据 API 地址和实际响应自动识别，无需手动选择'
  },
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
  return v === 'openai-responses' || v === 'openai-chat' || v === 'anthropic' ? v : 'auto'
}

/** Anthropic 的接口版本头。写死一个已知可用的版本，别跟着日期漂。 */
export const ANTHROPIC_VERSION = '2023-06-01'
/** Anthropic 必须显式给 max_tokens，OpenAI 那两套不给就是模型上限。 */
export const ANTHROPIC_MAX_TOKENS = 8192

const operationSuffix = /\/(?:chat\/completions|responses|messages|models)$/i

/** 完整端点保留其原有前缀；基础地址已有版本号时不再补 /v1。 */
export function apiEndpoint(apiBase: string, operation: string): string {
  const url = new URL(apiBase.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('API 地址需为不含用户名和密码的 http:// 或 https:// 地址')
  let path = url.pathname.replace(/\/+$/, '')
  if (operationSuffix.test(path)) path = path.replace(operationSuffix, '')
  else if (!/\/v\d+(?:beta\d*|alpha\d*)?$/i.test(path)) path += '/v1'
  url.pathname = `${path}/${operation}`
  url.hash = ''
  return url.toString()
}

export function apiFormatCandidates(apiBase: string): ConcreteApiFormat[] {
  const url = new URL(apiBase.trim())
  const path = url.pathname.replace(/\/+$/, '').toLowerCase()
  let first: ConcreteApiFormat = 'openai-chat'
  if (/\/responses$/.test(path)) first = 'openai-responses'
  else if (/\/chat\/completions$/.test(path)) first = 'openai-chat'
  else if (/\/(?:messages|anthropic)(?:\/v\d+)?$/.test(path)) first = 'anthropic'
  else if (url.hostname === 'api.anthropic.com') first = 'anthropic'
  else if (
    url.hostname === 'api.openai.com' ||
    (url.hostname === 'ark.cn-beijing.volces.com' && path === '/api/coding/v3')
  ) first = 'openai-responses'
  else if (url.hostname === 'ark.cn-beijing.volces.com' && path === '/api/coding')
    first = 'anthropic'
  const all: ConcreteApiFormat[] = ['openai-chat', 'openai-responses', 'anthropic']
  return [first, ...all.filter((format) => format !== first)]
}

export function chatEndpoint(apiBase: string, format: ConcreteApiFormat): string {
  return apiEndpoint(apiBase, format === 'anthropic' ? 'messages' : format === 'openai-chat' ? 'chat/completions' : 'responses')
}

export function chatHeaders(apiKey: string, format: ConcreteApiFormat): Record<string, string> {
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
  maxOutputTokens?: number
}

export function chatBody(req: ChatBodyInput, format: ConcreteApiFormat): Record<string, unknown> {
  if (format === 'anthropic') {
    return {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? ANTHROPIC_MAX_TOKENS,
      system: req.instructions,
      messages: toAnthropicMessages(req.input)
    }
  }
  if (format === 'openai-chat') {
    return {
      model: req.model,
      messages: toChatMessages(req.instructions, req.input),
      ...(req.maxOutputTokens === undefined ? {} : { max_tokens: req.maxOutputTokens })
    }
  }
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.instructions,
    input: req.input
  }
  if (req.effort) body.reasoning = { effort: req.effort }
  if (req.maxOutputTokens !== undefined) body.max_output_tokens = req.maxOutputTokens
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
export function chatText(data: unknown, format: ConcreteApiFormat): string {
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
