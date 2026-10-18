import { createHash } from 'node:crypto'
import {
  apiFormatCandidates,
  chatBody,
  chatEndpoint,
  chatError,
  chatHeaders,
  chatText,
  normalizeApiFormat,
  type ApiFormat,
  type ChatBodyInput,
  type ConcreteApiFormat
} from '../shared/api-formats.ts'
import { modelsEndpoint, parseModelList, type ModelProbeResult } from '../shared/model-configuration.ts'

interface ModelConfig {
  apiBase: string
  apiKey: string
  model: string
  apiFormat?: ApiFormat
}

type ModelRequest = Omit<ChatBodyInput, 'model'>
interface ModelResult {
  text: string
  format: ConcreteApiFormat
}

function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function matchesFormat(payload: unknown, format: ConcreteApiFormat): boolean {
  const data = record(payload)
  if (format === 'openai-chat') {
    const first = Array.isArray(data.choices) ? record(data.choices[0]) : {}
    const message = record(first.message)
    return 'content' in message || 'reasoning_content' in message || 'refusal' in message
  }
  if (format === 'anthropic')
    return Array.isArray(data.content) && (data.type === 'message' || data.content.some((part) => record(part).type === 'text'))
  return typeof data.output_text === 'string' ||
    (Array.isArray(data.output) && (data.object === 'response' || data.output.some((item) => record(item).type === 'message')))
}

function unsupportedParameter(detail: string, parameter: RegExp): boolean {
  return parameter.test(detail) && /unsupported|not supported|does not support|unknown|unrecognized|unexpected|invalid (?:value|parameter)|不支持/i.test(detail)
}

function terminalServiceError(detail: string): boolean {
  const payload = record(jsonValue(detail))
  const error = record(payload.error)
  const codes = [payload.code, payload.type, error.code, error.type]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .join(' ')
  if (/auth|permission|accessdenied|apikey|invalidkey|quota|credit|balance|billing|ratelimit|resourceexhausted|modelnotfound|invalidmodel|modelnotavailable|deploymentnotfound/.test(codes))
    return true
  return /model[_ -]?not[_ -]?found|invalid[_ -]?model|deployment[_ -]?not[_ -]?found|model.{0,100}(?:does not exist|not found|no access|not available|not exist)|模型.{0,30}(?:不存在|无权|不可用)|api.?key|permission|unauthori[sz]ed|quota|balance|credit|billing|rate.?limit|current plan/i.test(detail)
}

function protocolMismatch(status: number, detail: string, format: ConcreteApiFormat): boolean {
  if (terminalServiceError(detail)) return false
  if (status === 404 || status === 405) {
    return /not[_ -]?found|no (?:route|handler)|cannot (?:post|get)|unsupported (?:path|url)|method[_ -]?not[_ -]?allowed|404|405|不存在/i.test(detail)
  }
  if (status !== 400 && status !== 422) return false
  if (unsupportedParameter(detail, /endpoint|route|api (?:format|protocol)|responses api|chat completions api/i))
    return true
  const missing = /required|missing|must (?:provide|include)|field required|必填|缺少/i.test(detail)
  if (format === 'openai-responses')
    return (missing && /\bmessages\b/i.test(detail)) || unsupportedParameter(detail, /["']input["']/i)
  return (missing && /["']?input["']?\s*(?:["':,]|is required|field)/i.test(detail)) ||
    unsupportedParameter(detail, /["']messages["']/i)
}

function safeDetail(detail: string, key: string): string {
  return (key ? detail.replaceAll(key, '[已隐藏]') : detail).slice(0, 300)
}

function responseError(status: number, detail: string, key: string, headers: Headers): Error {
  const payload = jsonValue(detail)
  const message = status === 401 ? 'Key 被拒绝（401），请检查 API Key'
    : status === 403 ? '服务拒绝访问（403），请检查 Key 和模型权限'
      : status === 429 ? '请求过于频繁或额度不足（429），请稍后重试或检查服务额度'
        : `模型服务返回 ${status}：${safeDetail(chatError(payload) ?? detail, key)}`
  const raw = headers.get('retry-after')
  const retryAfterMs = raw == null ? undefined : /^\d+(?:\.\d+)?$/.test(raw.trim())
    ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - Date.now())
  return Object.assign(new Error(message), {
    status,
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {})
  })
}

export function createModelClient(fetcher: typeof fetch = fetch): {
  request: (config: ModelConfig, req: ModelRequest, signal: AbortSignal) => Promise<ModelResult>
  probe: (config: ModelConfig) => Promise<ModelProbeResult>
} {
  const formats = new Map<string, ConcreteApiFormat>()
  const cacheKey = (config: ModelConfig): string => createHash('sha256')
    .update(JSON.stringify([config.apiBase.trim().replace(/\/+$/, ''), config.apiKey.trim(), config.model.trim()]))
    .digest('hex')

  const request = async (config: ModelConfig, req: ModelRequest, signal: AbortSignal): Promise<ModelResult> => {
    signal.throwIfAborted()
    const base = config.apiBase.trim()
    const key = config.apiKey.trim()
    const model = config.model.trim()
    if (!base) throw new Error('请先填写 API 地址')
    // 统一在发送任何凭据之前验证 URL（包含协议和内嵌凭据）。
    try {
      chatEndpoint(base, 'openai-chat')
    } catch {
      throw new Error('API 地址需为不含用户名和密码的 http:// 或 https:// 地址')
    }
    if (!key) throw new Error('请先填写 API Key')
    if (!model) throw new Error('请先填写文本抽取模型名')
    const selected = normalizeApiFormat(config.apiFormat)
    const id = cacheKey(config)
    const cached = formats.get(id)
    const candidates = selected === 'auto' ? apiFormatCandidates(base) : [selected]
    if (selected === 'auto' && cached)
      candidates.splice(0, candidates.length, cached, ...candidates.filter((f) => f !== cached))

    for (let index = 0; index < candidates.length; index++) {
      signal.throwIfAborted()
      const format = candidates[index]
      const send = async (body: Record<string, unknown>): Promise<{ response: Response; detail: string }> => {
        try {
          const response = await fetcher(chatEndpoint(base, format), {
            method: 'POST',
            headers: chatHeaders(key, format),
            body: JSON.stringify(body),
            signal,
            redirect: 'error'
          })
          return { response, detail: await response.text() }
        } catch (error) {
          signal.throwIfAborted()
          throw new Error(`无法访问模型服务：${safeDetail(error instanceof Error ? error.message : String(error), key)}`)
        }
      }

      const body = chatBody({ ...req, model }, format)
      let result = await send(body)
      if (result.response.status === 400 && format === 'openai-responses' && req.effort &&
          !terminalServiceError(result.detail) &&
          unsupportedParameter(result.detail, /reasoning|effort/i)) {
        delete body.reasoning
        result = await send(body)
      }
      // 新版 OpenAI Chat 模型改用此参数；不因这个字段差异切换整个协议。
      if (result.response.status === 400 && format === 'openai-chat' && body.max_tokens !== undefined &&
          !terminalServiceError(result.detail) &&
          unsupportedParameter(result.detail, /max_tokens/i)) {
        body.max_completion_tokens = body.max_tokens
        delete body.max_tokens
        result = await send(body)
      }
      signal.throwIfAborted()
      if (!result.response.ok) {
        if (selected === 'auto' && protocolMismatch(result.response.status, result.detail, format)) {
          if (formats.get(id) === format) formats.delete(id)
          if (index < candidates.length - 1) continue
        }
        throw responseError(result.response.status, result.detail, key, result.response.headers)
      }
      const payload = jsonValue(result.detail)
      const error = chatError(payload)
      if (error) throw new Error(`模型服务错误：${safeDetail(error, key)}`)
      if (!matchesFormat(payload, format))
        throw new Error('模型服务未返回有效的模型响应，请检查 API 地址和接口格式')
      formats.set(id, format)
      if (formats.size > 128) formats.delete(formats.keys().next().value!)
      return { text: chatText(payload, format), format }
    }
    throw new Error('未找到可用的接口格式，请在高级选项中指定')
  }

  const probe = async (config: ModelConfig): Promise<ModelProbeResult> => {
    const signal = AbortSignal.timeout(30_000)
    try {
      const result = await request(config, {
        instructions: 'This is a connection test. Reply only with OK.',
        input: [{ role: 'user', content: 'Reply with OK.' }],
        maxOutputTokens: 64
      }, signal)
      let models: string[] = []
      // 有效推理已验证连接；模型枚举只是辅助，缺失或无权访问不推翻验证结果。
      try {
        const response = await fetcher(modelsEndpoint(config.apiBase), {
          headers: chatHeaders(config.apiKey, result.format),
          signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
          redirect: 'error'
        })
        if (response.ok) models = parseModelList(await response.json())
      } catch {
        // 部分 Coding Plan 不提供模型列表，用户仍可手填模型名。
      }
      return { ok: true, models, error: null, detectedFormat: result.format }
    } catch (error) {
      return {
        ok: false,
        models: [],
        detectedFormat: null,
        error: signal.aborted ? '连接超时（30 秒），请稍后重试' :
          safeDetail(error instanceof Error ? error.message : String(error), config.apiKey.trim())
      }
    }
  }
  return { request, probe }
}

export const modelClient = createModelClient()
