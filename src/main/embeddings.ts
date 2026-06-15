import { getSession } from './session'

/**
 * 本地记忆向量化：带 Supabase 登录态调 embed 网关（relay key 只在 Edge Function 里），
 * 返回每条文本的向量。向量与记忆都留在本地（仅文本短暂上云做嵌入，与解析同隐私模型）。
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const { functionsBase, token } = getSession()
  if (!functionsBase || !token) throw new Error('请先登录以使用记忆功能')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(`${functionsBase.replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`嵌入服务返回 ${res.status}`)
    const j = (await res.json()) as { embeddings?: number[][]; error?: string }
    if (j.error || !j.embeddings) throw new Error(j.error || '嵌入服务空响应')
    return j.embeddings
  } finally {
    clearTimeout(timer)
  }
}
