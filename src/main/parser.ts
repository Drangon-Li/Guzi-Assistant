import { getProfile, getSettings, listTasks } from './db'
import {
  buildInstructions,
  extractText,
  parseModelOutput,
  type ExistingTaskBrief,
  type ParsedItem,
  type ResponsesOutput
} from '@shared/parsing'
import { belongingPriorFromProfile } from '@shared/belonging-hints'
import { getSession } from './session'
import { broadcast } from './windows'

export type { ParsedItem }

type ParseAction = 'parse_text' | 'parse_vision'

/** 带可操作错误码的解析错误：401 未登录 / 402 积分不足 / 502 模型错误。驱动渲染层「去登录/去充值」CTA。 */
export class ParseError extends Error {
  code: '401' | '402' | '502'
  constructor(message: string, code: '401' | '402' | '502') {
    super(message)
    this.code = code
  }
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
  if (res.status === 401) throw new ParseError('登录已失效，请重新登录', '401')
  if (res.status === 402) throw new ParseError('积分不足，请充值后再用', '402')
  const payload = (await res.json().catch(() => ({}))) as {
    data?: ResponsesOutput
    error?: string
    balance?: number
  }
  if (!res.ok || payload.error) throw new ParseError(`解析服务错误：${payload.error ?? res.status}`, '502')
  // 扣费后余额随响应回传 → 广播给账户面板即时刷新（#71 心安：用户看得到扣了多少）
  if (typeof payload.balance === 'number') broadcast('eshell:balance-updated', payload.balance)
  return payload.data ?? ({} as ResponsesOutput)
}

/** 直连模型（开发/自托管兜底，BYOK 经 env ESHELL_API_*）。 */
async function viaDirect(
  instructions: string,
  input: unknown[],
  signal: AbortSignal
): Promise<ResponsesOutput> {
  const { apiBase, apiKey, model } = getSettings()
  if (!apiBase || !apiKey) throw new Error('请先登录以使用解析服务')
  let res: Response
  try {
    res = await fetch(`${apiBase.replace(/\/$/, '')}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, instructions, input, reasoning: { effort: 'low' } }),
      signal
    })
  } catch (e) {
    if (signal.aborted) throw new Error('解析超时（120 秒），请重试')
    throw new Error(`解析服务无法访问：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new Error(`解析服务返回 ${res.status}：${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as ResponsesOutput
}

/** 调用解析模型并返回输出文本；优先走托管网关(登录态)，否则 env 直连兜底；120s 超时。 */
export async function callModel(
  instructions: string,
  input: unknown[],
  action: ParseAction = 'parse_text'
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const { functionsBase, token } = getSession()
    const data =
      functionsBase && token
        ? await viaGateway(functionsBase, token, instructions, input, action, controller.signal)
        : await viaDirect(instructions, input, controller.signal)
    if (data.error?.message) throw new Error(`解析服务错误：${data.error.message}`)
    return extractText(data).trim()
  } finally {
    clearTimeout(timer)
  }
}

export async function parseToItems(input: {
  text?: string
  imageDataUrl?: string
  hint: string
}): Promise<ParsedItem[]> {
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
    buildInstructions(profile, existing, belongingPriorFromProfile(profile)),
    [{ role: 'user', content }],
    input.imageDataUrl ? 'parse_vision' : 'parse_text'
  )
  return parseModelOutput(output)
}
