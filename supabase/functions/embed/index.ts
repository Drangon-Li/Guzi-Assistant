/**
 * 嵌入网关 —— Supabase Edge Function（Deno）。给客户端做本地记忆的向量化（语义检索/去重）。
 *
 * 与 parse 网关同架构：relay key 只活在函数里，客户端带 Supabase 登录态调用 → 函数验身份 →
 * 转发我方 relay 的 OpenAI 兼容 /v1/embeddings。嵌入 COGS 极低（~chat 的千分之一），不单独计积分
 * （抽取记忆的 chat 调用已在 parse 计费，避免重复计费 = 准确计费）。
 *
 * 部署：supabase functions deploy embed
 * 密钥：ESHELL_LLM_BASE / ESHELL_LLM_KEY（与 parse 共用）；ESHELL_EMBED_MODEL 可选，默认 text-embedding-3-small。
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'

const LLM_BASE = Deno.env.get('ESHELL_LLM_BASE') ?? ''
const LLM_KEY = Deno.env.get('ESHELL_LLM_KEY') ?? ''
const EMBED_MODEL = Deno.env.get('ESHELL_EMBED_MODEL') ?? 'text-embedding-3-small'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type'
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: userData, error: authErr } = await admin.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authErr || !userData?.user) return json({ error: '未登录' }, 401)

    const { input } = (await req.json()) as { input: string | string[] }
    const texts = (Array.isArray(input) ? input : [input]).filter(
      (t): t is string => typeof t === 'string' && t.length > 0
    )
    if (!texts.length) return json({ error: '空输入' }, 400)

    const res = await fetch(`${LLM_BASE.replace(/\/$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts })
    })
    if (!res.ok) return json({ error: `嵌入服务返回 ${res.status}` }, 502)
    const j = (await res.json()) as { data?: { embedding: number[] }[] }
    const embeddings = (j.data ?? []).map((d) => d.embedding)
    if (!embeddings.length) return json({ error: '嵌入服务空响应' }, 502)
    return json({ embeddings })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
