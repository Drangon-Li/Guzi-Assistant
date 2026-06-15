/**
 * 模型解析网关（#39 托管 AI / #41 用量计费）—— Supabase Edge Function（Deno）。
 *
 * 「数据库即后端」架构：不另起服务器，密钥(relay key / service-role)只活在 Edge Function 里，
 * 客户端带 Supabase 登录态调用本函数 → 函数验身份 → 按 #63 积分逻辑扣费 → 转发我方模型 relay →
 * 写流水。客户端永远拿不到模型 key（#39 核心：用户不配 key、注册登录即用）。
 *
 * 复用 server/billing/credits.ts(#63) 的纯积分逻辑（Deno 可直接 import 纯 TS）。
 *
 * 部署：supabase functions deploy parse
 * 所需密钥（supabase secrets set）：
 *   ESHELL_LLM_BASE  = http://101.201.227.31:9000   （我方模型 relay，国内 HTTP）
 *   ESHELL_LLM_KEY   = <relay key>
 *   ESHELL_LLM_MODEL = gpt-5.5
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台注入
 * 注：relay 是国内 IP，若 Edge runtime 到不了，需在 relay 侧加公网入口或走代理（部署时验证）。
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { creditCost, type BillableAction } from '../../../server/billing/credits.ts'

const LLM_BASE = Deno.env.get('ESHELL_LLM_BASE') ?? ''
const LLM_KEY = Deno.env.get('ESHELL_LLM_KEY') ?? ''
const LLM_MODEL = Deno.env.get('ESHELL_LLM_MODEL') ?? 'gpt-5.5'

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
    // 1. 验身份：用调用方的 JWT 取 user
    const { data: userData, error: authErr } = await admin.auth.getUser(authHeader.replace('Bearer ', ''))
    const user = userData?.user
    if (authErr || !user) return json({ error: '未登录' }, 401)

    const { action, instructions, input } = (await req.json()) as {
      action: BillableAction
      instructions: string
      input: unknown[]
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

    // 3. 转发我方模型 relay（与客户端 parser 同形）。失败不扣（#56 心安）。
    const res = await fetch(`${LLM_BASE.replace(/\/$/, '')}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, instructions, input, reasoning: { effort: 'low' } })
    })
    if (!res.ok) return json({ error: `解析服务返回 ${res.status}` }, 502)
    const data = await res.json()

    // 4. 成功后原子扣费（deduct_credits：for update 行锁，含月度重置 + 写流水，防并发超扣）
    const { data: charge } = await admin.rpc('deduct_credits', {
      p_user: user.id,
      p_cost: cost,
      p_reason: reason
    })
    const balance = (charge as { balance?: number } | null)?.balance ?? null

    return json({ data, balance })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
