/**
 * 模型解析网关（#39 托管 AI / #41 用量计费）—— Supabase Edge Function（Deno）。
 *
 * 「数据库即后端」架构：不另起服务器，密钥(relay key / service-role)只活在 Edge Function 里，
 * 客户端带 Supabase 登录态调用本函数 → 函数验身份 → 按 #63 积分逻辑扣费 → 转发我方模型 relay →
 * 写流水。客户端永远拿不到模型 key（#39 核心：用户不配 key、注册登录即用）。
 *
 * 复用 server/billing/credits.ts(#63) 的纯积分逻辑（Deno 可直接 import 纯 TS）。
 *
 * ⚙️ 上游 relay = OpenAI **Chat Completions**（`/v1/chat/completions`，yunwu.ai 聚合，Edge 可达的公网
 * HTTPS）。本函数做适配层：把客户端的 Responses 风格请求（{instructions, input}）转成 chat messages，
 * 再把回复包成 `{output_text}` —— 让客户端 extractText 原样可用（客户端 / 共享解析零改动）。
 *
 * 部署：supabase functions deploy parse
 * 所需密钥（supabase secrets set）：
 *   ESHELL_LLM_BASE         = https://yunwu.ai
 *   ESHELL_LLM_KEY          = <relay key>
 *   ESHELL_LLM_MODEL        = deepseek-v4-flash   // 文本 / 对话
 *   ESHELL_LLM_MODEL_VISION = qwen3.5-plus        // 含图（parse_vision）走多模态
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台注入
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { creditCost, type BillableAction } from '../../../server/billing/credits.ts'

const LLM_BASE = Deno.env.get('ESHELL_LLM_BASE') ?? ''
const LLM_KEY = Deno.env.get('ESHELL_LLM_KEY') ?? ''
const LLM_MODEL = Deno.env.get('ESHELL_LLM_MODEL') ?? 'deepseek-v4-flash'
// 含图请求（parse_vision）走多模态模型；文本/对话用上面的便宜模型
const LLM_MODEL_VISION = Deno.env.get('ESHELL_LLM_MODEL_VISION') ?? 'qwen3.5-plus'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type'
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

/** Responses 风格 content 段 */
type RPart = { type: string; text?: string; image_url?: string }
type RTurn = { role: string; content: RPart[] }
type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** 把 {instructions, input(Responses 风格)} 适配成 OpenAI Chat Completions messages。 */
function toMessages(instructions: string, input: RTurn[]): unknown[] {
  const messages: unknown[] = []
  if (instructions) messages.push({ role: 'system', content: instructions })
  for (const turn of input ?? []) {
    const parts: ChatPart[] = (turn.content ?? []).map((c) =>
      c.type === 'input_image' && c.image_url
        ? { type: 'image_url', image_url: { url: c.image_url } }
        : { type: 'text', text: c.text ?? '' }
    )
    // 纯文本时压成字符串（最大兼容，避免个别模型不收 content 数组）
    const onlyText = parts.every((p) => p.type === 'text')
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: onlyText ? parts.map((p) => (p as { text: string }).text).join('\n') : parts
    })
  }
  return messages
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    // 1. 验身份：用调用方的 JWT 取 user
    const { data: userData, error: authErr } = await admin.auth.getUser(authHeader.replace('Bearer ', ''))
    const user = userData?.user
    if (authErr || !user) return json({ error: '未登录' }, 401)

    const { action, instructions, input } = (await req.json()) as {
      action: BillableAction
      instructions: string
      input: RTurn[]
    }
    const reason = action ?? 'parse_text'
    const cost = creditCost(reason)

    // 2. 预检余额（含本月赠送将重置的情形）→ 明显不足则不调模型，直接 402
    const { data: row } = await admin
      .from('credits')
      .select('grant_balance, grant_reset_at, purchased_balance, monthly_grant')
      .eq('user_id', user.id)
      .single()
    if (!row) return json({ error: '账户未初始化' }, 403)
    const willReset = Date.now() >= new Date(row.grant_reset_at).getTime()
    const affordable = (willReset ? row.monthly_grant : row.grant_balance) + row.purchased_balance
    if (affordable < cost)
      return json({ error: '积分不足', balance: row.grant_balance + row.purchased_balance }, 402)

    // 3. 转发上游 relay（OpenAI Chat Completions）。失败不扣（#56 心安）。
    const res = await fetch(`${LLM_BASE.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: reason === 'parse_vision' ? LLM_MODEL_VISION : LLM_MODEL,
        messages: toMessages(instructions, input)
      })
    })
    if (!res.ok) return json({ error: `解析服务返回 ${res.status}` }, 502)
    const completion = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const text = completion?.choices?.[0]?.message?.content ?? ''
    if (!text) return json({ error: '解析服务空响应' }, 502)

    // 4. 成功后原子扣费（deduct_credits：for update 行锁，含月度重置 + 写流水，防并发超扣）
    const { data: charge } = await admin.rpc('deduct_credits', {
      p_user: user.id,
      p_cost: cost,
      p_reason: reason
    })
    const balance = (charge as { balance?: number } | null)?.balance ?? null

    // 包成 Responses 形状（output_text）→ 客户端 extractText 原样可用
    return json({ data: { output_text: text }, balance })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
