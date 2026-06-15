/**
 * chpay 订单状态查询 Edge Function（#41 / #68）。
 * 客户端付款后轮询本函数拿订单状态（pending/paid），只允许查自己的订单。
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: ud } = await admin.auth.getUser((req.headers.get('Authorization') ?? '').replace('Bearer ', ''))
    const user = ud?.user
    if (!user) return json({ error: '请先登录' }, 401)

    const outTradeNo = new URL(req.url).searchParams.get('out_trade_no')
    if (!outTradeNo) return json({ error: '缺少订单号' }, 400)

    const { data: order } = await admin
      .from('orders')
      .select('status, amount_cents, kind, credits')
      .eq('out_trade_no', outTradeNo)
      .eq('user_id', user.id) // 只查自己的
      .single()
    if (!order) return json({ error: '订单不存在' }, 404)

    return json(order)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
