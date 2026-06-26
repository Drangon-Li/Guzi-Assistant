/**
 * 模型解析网关（#39 托管 AI / #41 用量计费）—— Supabase Edge Function（Deno）。
 *
 * 「数据库即后端」架构：不另起服务器，密钥(relay key / service-role)只活在 Edge Function 里，
 * 客户端带 Supabase 登录态调用本函数 → 函数验身份 → 按 #63 积分逻辑扣费 → 转发我方模型 relay →
 * 写流水。客户端永远拿不到模型 key（#39 核心：用户不配 key、注册登录即用）。
 *
 * 复用 server/billing/credits.ts(#63) 的纯积分逻辑（Deno 可直接 import 纯 TS）。
 *
 * ⚙️ 上游 relay = OpenAI **Chat Completions**（`/v1/chat/completions`）。本函数做适配层：把客户端的
 * Responses 风格请求（{instructions, input}）转成 chat messages，回复包成 `{output_text}` ——
 * 客户端 extractText 原样可用（客户端 / 共享解析零改动）。
 *
 * 上游为「主用 + 兜底」：主用 #85 自部署 A100 站（省钱），掉线/超时/空响应自动切 yunwu 兜底。
 * ⚠️ A100 是 HTTP（非 HTTPS）公网 IP：key 经公网明文转发，属内部服务端调用、仓库私有，按 #85 接受此风险。
 *
 * 部署：supabase functions deploy parse
 * 所需密钥（supabase secrets set）：
 *   主用（A100，#85）：
 *     ESHELL_LLM_BASE         = http://<A100 公网地址>        // 不含 /v1，本函数自动补
 *     ESHELL_LLM_KEY          = <团队共享 key>
 *     ESHELL_LLM_MODEL        = Qwen3.5-122B-A10B-GPTQ-Int4   // 文本/对话（思考型，自动关思考）
 *     ESHELL_LLM_MODEL_VISION = Qwen3-Omni-30B-A3B-Instruct   // 含图（parse_vision）
 *   兜底（yunwu，可选；不配 base/key 则无兜底）：
 *     ESHELL_LLM_FALLBACK_BASE         = https://yunwu.ai
 *     ESHELL_LLM_FALLBACK_KEY          = <yunwu relay key>
 *     ESHELL_LLM_FALLBACK_MODEL        = deepseek-v4-flash
 *     ESHELL_LLM_FALLBACK_MODEL_VISION = qwen3.5-plus
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台注入
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { creditCost, type BillableAction } from '../../../server/billing/credits.ts'

/** 一个上游 relay 配置（OpenAI Chat Completions 兼容）。base/key 走 secrets，未配置即视为不可用。 */
interface Upstream {
  base: string
  key: string
  model: string // 文本 / 对话
  modelVision: string // 含图（parse_vision）走多模态
  noThinkText: boolean // 文本模型是思考型时，传 enable_thinking:false 拿干净输出
}

// 主用：#85 自部署 A100 站（OpenAI 兼容 newapi）。旗舰文本模型是思考型 → 默认关思考。
const PRIMARY: Upstream = {
  base: Deno.env.get('ESHELL_LLM_BASE') ?? '',
  key: Deno.env.get('ESHELL_LLM_KEY') ?? '',
  model: Deno.env.get('ESHELL_LLM_MODEL') ?? 'Qwen3.5-122B-A10B-GPTQ-Int4',
  modelVision: Deno.env.get('ESHELL_LLM_MODEL_VISION') ?? 'Qwen3-Omni-30B-A3B-Instruct',
  noThinkText: Deno.env.get('ESHELL_LLM_NO_THINK') !== 'false'
}
// 兜底：yunwu 聚合（A100 单点掉线时自动切；未配 base/key 则跳过兜底）。yunwu 模型非思考型 → 默认不关思考。
const FALLBACK: Upstream = {
  base: Deno.env.get('ESHELL_LLM_FALLBACK_BASE') ?? '',
  key: Deno.env.get('ESHELL_LLM_FALLBACK_KEY') ?? '',
  model: Deno.env.get('ESHELL_LLM_FALLBACK_MODEL') ?? 'deepseek-v4-flash',
  modelVision: Deno.env.get('ESHELL_LLM_FALLBACK_MODEL_VISION') ?? 'qwen3.5-plus',
  noThinkText: Deno.env.get('ESHELL_LLM_FALLBACK_NO_THINK') === 'true'
}

const PRIMARY_TIMEOUT_MS = 45_000 // A100 没响应就快速切兜底（客户端总超时 120s）
const FALLBACK_TIMEOUT_MS = 60_000

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

/** 调一个上游 relay，成功返回文本；不可用/超时/失败/空响应一律返回 null（交由调用方切兜底）。 */
async function callUpstream(
  up: Upstream,
  isVision: boolean,
  instructions: string,
  input: RTurn[],
  timeoutMs: number,
  deterministic: boolean
): Promise<string | null> {
  if (!up.base || !up.key) return null
  const body: Record<string, unknown> = {
    model: isVision ? up.modelVision : up.model,
    messages: toMessages(instructions, input)
  }
  // 抽取类(parse_text/parse_vision)用 temperature 0 拿稳定可复现的 JSON；对话(chat)保留默认采样的自然度
  if (deterministic) body.temperature = 0
  // 思考型文本模型：关思考拿干净 JSON；多模态/非思考模型不传（个别模板会因未知 kwarg 报错）
  if (!isVision && up.noThinkText) body.chat_template_kwargs = { enable_thinking: false }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${up.base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${up.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!res.ok) return null
    const completion = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[]
    } | null
    return completion?.choices?.[0]?.message?.content || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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

    // 3. 转发上游 relay：主用 A100，掉线/超时/空响应自动切 yunwu 兜底。失败不扣（#56 心安）。
    const isVision = reason === 'parse_vision'
    const deterministic = reason !== 'chat' // 抽取确定性可复现；对话保留自然采样
    let text = await callUpstream(PRIMARY, isVision, instructions, input, PRIMARY_TIMEOUT_MS, deterministic)
    if (!text) text = await callUpstream(FALLBACK, isVision, instructions, input, FALLBACK_TIMEOUT_MS, deterministic)
    if (!text) return json({ error: '解析服务暂时不可用，请稍后重试' }, 502)

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
