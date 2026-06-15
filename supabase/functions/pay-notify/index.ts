/**
 * chpay 回调验签入账 Edge Function（#41 / #68）。
 * 验签(#51 平台公钥) → 金额核对 → 幂等(已 paid 直接 success) → 改订单 paid + 到账加积分 + 写流水。
 * 平台回调 GET/POST 都支持；**响应体必须是字符串 `success`**（chpay 协议）。
 *
 * 到账规则（#56）：kind='credits' → 加 purchased(不过期)；kind='membership' → 设 monthly_grant 并立即
 * 重置当月赠送（激活会员的每月赠送，后续由 parse 网关的 applyMonthlyGrant 续期）。
 *
 * secrets：CHPAY_PLATFORM_PUBLIC_KEY；SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 平台注入
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { verifyParams, amountMatchesYuan } from '../../../server/chpay/sign.ts'

const ok = () => new Response('success')
const fail = (s = 400) => new Response('fail', { status: s })

async function readParams(req: Request): Promise<Record<string, string>> {
  const p: Record<string, string> = {}
  if (req.method === 'GET') {
    new URL(req.url).searchParams.forEach((v, k) => (p[k] = v))
  } else {
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) Object.assign(p, await req.json())
    else (await req.formData()).forEach((v, k) => (p[k] = v.toString()))
  }
  return p
}

Deno.serve(async (req) => {
  try {
    const params = await readParams(req)
    if (!verifyParams(params, Deno.env.get('CHPAY_PLATFORM_PUBLIC_KEY') ?? '')) return fail(400)
    if (params.trade_status !== 'TRADE_SUCCESS') return ok() // 非成功态，ack 不处理

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: order } = await admin
      .from('orders')
      .select('*')
      .eq('out_trade_no', params.out_trade_no)
      .single()
    if (!order) return fail(404)
    if (order.status === 'paid') return ok() // 幂等：已处理
    if (!amountMatchesYuan(order.amount_cents, params.money ?? '')) return fail(400) // 金额不符

    const { data: flipped, error: updErr } = await admin
      .from('orders')
      .update({ status: 'paid', trade_no: params.trade_no ?? null, paid_at: new Date().toISOString() })
      .eq('out_trade_no', order.out_trade_no)
      .eq('status', 'pending') // 乐观锁：只从 pending→paid
      .select('out_trade_no')
    if (updErr) return fail(500)
    // 0 行=并发的另一个回调已抢先 pending→paid → 幂等返回，绝不重复加积分
    if (!flipped || flipped.length === 0) return ok()

    // 到账：调原子 RPC（for update 行锁 + 写流水），按 kind 分流。flip-gate 已保证只此一次。
    if (order.kind === 'credits') {
      await admin.rpc('add_credits', {
        p_user: order.user_id,
        p_credits: order.credits ?? 0,
        p_reason: 'purchase',
        p_ref: order.out_trade_no
      })
    } else {
      // 会员：设月赠额并立即激活本月赠送（order.credits = 该档月度积分）
      await admin.rpc('activate_membership', {
        p_user: order.user_id,
        p_monthly: order.credits ?? 1000,
        p_ref: order.out_trade_no
      })
    }
    return ok()
  } catch {
    return fail(500)
  }
})
