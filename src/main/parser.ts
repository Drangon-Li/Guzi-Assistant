import { getProfile, getSettings } from './db'
import {
  buildInstructions,
  extractText,
  parseModelOutput,
  type ParsedItem,
  type ResponsesOutput
} from '@shared/parsing'

export type { ParsedItem }

export async function parseToItems(input: {
  text?: string
  imageDataUrl?: string
  hint: string
}): Promise<ParsedItem[]> {
  const profile = getProfile()
  if (!profile) throw new Error('尚未完成用户档案设置')
  const { apiBase, apiKey, model } = getSettings()
  if (!apiBase || !apiKey) throw new Error('尚未配置解析 API，请到设置页填写')

  const content: Record<string, string>[] = []
  const text = input.text?.trim()
  content.push({
    type: 'input_text',
    text: `${input.hint}${text ? `\n\n=== 用户提交的内容 ===\n${text}` : ''}`
  })
  if (input.imageDataUrl) content.push({ type: 'input_image', image_url: input.imageDataUrl })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  let data: ResponsesOutput
  try {
    let res: Response
    try {
      res = await fetch(`${apiBase.replace(/\/$/, '')}/v1/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          instructions: buildInstructions(profile),
          input: [{ role: 'user', content }],
          reasoning: { effort: 'low' }
        }),
        signal: controller.signal
      })
    } catch (e) {
      if (controller.signal.aborted) throw new Error('解析超时（120 秒），请重试')
      throw new Error(`解析服务无法访问：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(`解析服务返回 ${res.status}：${body}`)
    }
    // 读 body 也要在超时保护内，慢速流式响应不能永久挂起
    data = (await res.json()) as ResponsesOutput
  } finally {
    clearTimeout(timer)
  }
  if (data.error?.message) throw new Error(`解析服务错误：${data.error.message}`)
  return parseModelOutput(extractText(data).trim())
}
