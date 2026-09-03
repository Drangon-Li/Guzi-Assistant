import { getProfile, getSettings, listTasks, listTaskTags, personalMemoryText } from './db'
import {
  buildInstructions,
  extractText,
  parseModelOutput,
  type ExistingTaskBrief,
  type ParsedItem,
  type ResponsesOutput
} from '@shared/parsing'
import { belongingPriorFromProfile } from '@shared/belonging-hints'
import {
  modelForAction,
  modelsEndpoint,
  parseModelList,
  type ModelAction,
  type ModelProbeResult
} from '@shared/model-configuration'
import {
  chatBody,
  chatEndpoint,
  chatError,
  chatHeaders,
  chatText,
  normalizeApiFormat,
  type ApiFormat,
  type CanonicalMessage
} from '@shared/api-formats'
import { getSession } from './session'

export type { ParsedItem }

type ParseAction = ModelAction

/** 云端解析可用性：已登录（网关）或已配直连 API，且完成档案设置。未就绪时监控静默跳过，不白跑截图/OCR。 */
export function cloudReady(): boolean {
  const { functionsBase, token } = getSession()
  const { apiBase, apiKey } = getSettings()
  if (!((functionsBase && token) || (apiBase && apiKey))) return false
  return !!getProfile()
}

/** 走托管 parse 网关（#39/#70）：带 Supabase 登录 token，由 Edge Function 扣积分 + 转发我方模型。 */
async function viaGateway(
  functionsBase: string,
  token: string,
  instructions: string,
  input: unknown[],
  action: ParseAction,
  signal: AbortSignal
): Promise<ResponsesOutput> {
  let res: Response
  try {
    res = await fetch(`${functionsBase.replace(/\/$/, '')}/parse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, instructions, input }),
      signal
    })
  } catch (e) {
    if (signal.aborted) throw new Error('解析超时（120 秒），请重试')
    throw new Error(`解析服务无法访问：${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 401) throw new Error('登录已失效，请重新登录')
  const payload = (await res.json().catch(() => ({}))) as {
    data?: ResponsesOutput
    error?: string
  }
  // 402 文案随计费状态变化（订阅到期/试用结束/额度用尽），以服务端返回为准
  if (res.status === 402) throw new Error(payload.error ?? '订阅已到期，请续订')
  if (!res.ok || payload.error) throw new Error(`解析服务错误：${payload.error ?? res.status}`)
  return payload.data ?? ({} as ResponsesOutput)
}

/** 直连模型（开发/自托管兜底，兼容 GUZI_ASSISTANT_API_*、OPENAI_* 和旧 ESHELL_API_*）。
 *  按设置里选的接口格式翻译请求：Responses / Chat Completions / Anthropic Messages。 */
async function viaDirect(
  instructions: string,
  rawInput: unknown[],
  action: ParseAction,
  signal: AbortSignal
): Promise<string> {
  const settings = getSettings()
  const { apiBase, apiKey, useCustomModel } = settings
  const format = normalizeApiFormat(settings.apiFormat)
  const model = modelForAction(action, settings)
  if (!apiBase || !apiKey)
    throw new Error(
      useCustomModel ? '自定义模型未配置完整，请在设置 → 助手里填写 API 地址与 Key' : '请先登录以使用解析服务'
    )

  const send = async (body: Record<string, unknown>): Promise<Response> => {
    try {
      return await fetch(chatEndpoint(apiBase, format), {
        method: 'POST',
        headers: chatHeaders(apiKey, format),
        body: JSON.stringify(body),
        signal
      })
    } catch (e) {
      if (signal.aborted) throw new Error('解析超时（120 秒），请重试')
      throw new Error(`解析服务无法访问：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const input = rawInput as CanonicalMessage[]
  // 抽取只要一段结构化 JSON，推理纯属浪费：同一请求实测 effort=none 比默认快 6 倍
  // （8.5s → 1.4s，925 输出 token 里 803 是推理），解析结果一致。
  // 对话保留 low —— 那里的思考对回答质量有实际帮助。effort 只有 Responses 那套吃。
  const effort = action === 'chat' ? 'low' : 'none'
  const plain = { model, instructions, input }
  let res = await send(chatBody({ ...plain, effort }, format))
  if (res.status === 400 && format === 'openai-responses') {
    // BYOK 可以指向任意服务，非推理模型会因为不认识 reasoning 参数直接 400。
    // 只在报错确实指向这个参数时退一步重试，不做无差别兜底。
    const detail = await res.text()
    if (!/reasoning|effort/i.test(detail))
      throw new Error(`解析服务返回 400：${detail.slice(0, 300)}`)
    res = await send(chatBody(plain, format))
  }
  if (!res.ok) throw new Error(`解析服务返回 ${res.status}：${(await res.text()).slice(0, 300)}`)
  const json: unknown = await res.json()
  const err = chatError(json)
  if (err) throw new Error(`解析服务错误：${err}`)
  return chatText(json, format)
}

/** 调用解析模型并返回输出文本；优先走托管网关(登录态)，否则 env 直连兜底；120s 超时。 */
export async function callModel(
  instructions: string,
  input: unknown[],
  action: ParseAction = 'parse_text',
  externalSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const { functionsBase, token } = getSession()
    const { useCustomModel, apiBase, apiKey } = getSettings()
    // 自定义模型显式开启且配置完整时优先于托管网关——否则用户填了自己的 API 却因为
    // 登录着而完全不生效，是最容易让人以为「填了没用」的坑。
    const preferDirect = useCustomModel && !!apiBase && !!apiKey
    if (!preferDirect && functionsBase && token) {
      const data = await viaGateway(functionsBase, token, instructions, input, action, controller.signal)
      if (data.error?.message) throw new Error(`解析服务错误：${data.error.message}`)
      return extractText(data).trim()
    }
    return (await viaDirect(instructions, input, action, controller.signal)).trim()
  } catch (e) {
    if (externalSignal?.aborted) throw new Error('解析已取消')
    throw e
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/** 设置页「检测连接」：GET /v1/models 校验地址与 Key 并取回可选模型。
 *  注意它只验证凭据与连通性——真正推理走 /responses，两者未必同时可用，UI 文案需说明。 */
export async function probeModelEndpoint(
  apiBase: string,
  apiKey: string,
  apiFormat?: string
): Promise<ModelProbeResult> {
  const base = apiBase.trim()
  const key = apiKey.trim()
  const format = normalizeApiFormat(apiFormat ?? getSettings().apiFormat)
  const fail = (error: string): ModelProbeResult => ({
    ok: false,
    models: [],
    error,
    responsesAvailable: null
  })
  if (!base) return fail('请先填写 API 地址')
  if (!/^https?:\/\//i.test(base)) return fail('API 地址需以 http:// 或 https:// 开头')
  if (!key) return fail('请先填写 API Key')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    // 模型列表端点：Anthropic 也有 /v1/models，但要 x-api-key 头
    const res = await fetch(modelsEndpoint(base), {
      headers: chatHeaders(key, format),
      signal: controller.signal
    })
    if (res.status === 401 || res.status === 403)
      return fail(`Key 被拒绝（${res.status}），请检查 API Key`)
    if (!res.ok)
      return fail(`接口返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`)
    return {
      ok: true,
      models: parseModelList(await res.json().catch(() => null)),
      error: null,
      responsesAvailable: await probeChatEndpoint(base, key, format, controller.signal)
    }
  } catch (e) {
    if (controller.signal.aborted) return fail('连接超时（15 秒）')
    return fail(`无法访问：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 所选格式的推理端点到底在不在。很多「OpenAI 兼容」服务只实现了 /v1/chat/completions，
 *  拿不到 /v1/responses；反过来填错格式打 Anthropic 也是一样的症状。
 *  故意发一个不合法的空 body：404/405 说明端点不存在，其他状态码说明存在、只是拒绝了这个请求。
 *  不带 model/messages，所以不会真的推理、不消耗 token。 */
async function probeChatEndpoint(
  base: string,
  key: string,
  format: ApiFormat,
  signal: AbortSignal
): Promise<boolean | null> {
  try {
    const res = await fetch(chatEndpoint(base, format), {
      method: 'POST',
      headers: chatHeaders(key, format),
      body: '{}',
      signal
    })
    if (res.status === 404 || res.status === 405) return false
    return true
  } catch {
    return null // 网络层失败：说不清端点在不在，别给用户假结论
  }
}

/** 同 parseToItems，但额外返回模型原始输出（供屏幕感知从同一次调用里再解析 work_summary）。 */
export async function parseToItemsRaw(input: {
  text?: string
  imageDataUrl?: string
  hint: string
  signal?: AbortSignal
}): Promise<{ items: ParsedItem[]; raw: string }> {
  const profile = getProfile()
  if (!profile) throw new Error('尚未完成用户档案设置')

  const content: Record<string, string>[] = []
  const text = input.text?.trim()
  content.push({
    type: 'input_text',
    text: `${input.hint}${text ? `\n\n=== 用户提交的内容 ===\n${text}` : ''}`
  })
  if (input.imageDataUrl) content.push({ type: 'input_image', image_url: input.imageDataUrl })

  const existing: ExistingTaskBrief[] = listTasks()
    .filter((t) => t.status !== 'ignored' && t.status !== 'done')
    .slice(0, 60)
    .map((t) => ({ title: t.title, due_time: t.dueTime }))

  const output = await callModel(
    buildInstructions(profile, existing, belongingPriorFromProfile(profile), personalMemoryText(), listTaskTags()),
    [{ role: 'user', content }],
    input.imageDataUrl ? 'parse_vision' : 'parse_text',
    input.signal
  )
  return { items: parseModelOutput(output), raw: output }
}

export async function parseToItems(input: {
  text?: string
  imageDataUrl?: string
  hint: string
  signal?: AbortSignal
}): Promise<ParsedItem[]> {
  return (await parseToItemsRaw(input)).items
}
