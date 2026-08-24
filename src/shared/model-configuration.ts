export interface DirectModelEnvironment {
  GUZI_ASSISTANT_API_BASE?: string
  GUZI_ASSISTANT_API_KEY?: string
  GUZI_ASSISTANT_MODEL?: string
  OPENAI_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  ESHELL_API_BASE?: string
  ESHELL_API_KEY?: string
  ESHELL_MODEL?: string
}

export interface DirectModelSettings {
  apiBase: string
  apiKey: string
  model: string
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value?.trim()) return value.trim()
  }
  return ''
}

export function resolveDirectModelSettings(
  stored: Partial<DirectModelSettings>,
  env: DirectModelEnvironment
): DirectModelSettings {
  return {
    apiBase:
      stored.apiBase ??
      firstNonBlank(env.GUZI_ASSISTANT_API_BASE, env.OPENAI_BASE_URL, env.ESHELL_API_BASE),
    apiKey:
      stored.apiKey ??
      firstNonBlank(env.GUZI_ASSISTANT_API_KEY, env.OPENAI_API_KEY, env.ESHELL_API_KEY),
    model:
      stored.model !== undefined
        ? stored.model
        : firstNonBlank(env.GUZI_ASSISTANT_MODEL, env.OPENAI_MODEL, env.ESHELL_MODEL) ||
          'gpt-5.5'
  }
}

export function responsesEndpoint(apiBase: string): string {
  return `${normalizedV1(apiBase)}/responses`
}

/** OpenAI 兼容服务的模型列表端点（GET）。用于设置页探测连通性并拉取可选模型。 */
export function modelsEndpoint(apiBase: string): string {
  return `${normalizedV1(apiBase)}/models`
}

function normalizedV1(apiBase: string): string {
  const base = apiBase.trim().replace(/\/+$/, '')
  return /\/v1$/i.test(base) ? base : `${base}/v1`
}

export interface ModelProbeResult {
  ok: boolean
  /** 接口返回的模型 id 列表（已去重排序）；失败时为空 */
  models: string[]
  /** 失败原因（面向用户的中文说明）；成功时为 null */
  error: string | null
  /** 解析实际要用的 /v1/responses 是否存在。false=确定没有（404/405），null=没测出来 */
  responsesAvailable: boolean | null
}

/** 解析 /v1/models 的返回。各家兼容程度不一，只认 id 字段，拿不到就当空列表。 */
export function parseModelList(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(payload) ? payload : []
  const ids = new Set<string>()
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (row as { id?: unknown })?.id
    if (typeof id === 'string' && id.trim()) ids.add(id.trim())
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export type ModelAction = 'parse_text' | 'parse_vision' | 'chat'

export interface ModelTiers {
  model: string
  modelVision: string
  modelChat: string
}

/** 按调用类型挑模型。三类需求差别很大：读图必须多模态，对话要会话质量，
 *  抽取只要结构化输出。留空即回落到文本档，所以只填一个也能用。 */
export function modelForAction(action: ModelAction, tiers: ModelTiers): string {
  const fallback = tiers.model.trim()
  if (action === 'parse_vision') return tiers.modelVision.trim() || fallback
  if (action === 'chat') return tiers.modelChat.trim() || fallback
  return fallback
}
