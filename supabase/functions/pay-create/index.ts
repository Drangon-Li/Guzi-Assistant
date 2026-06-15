/**
 * chpay 统一下单 Edge Function（#41 / #68）。架构=数据库即后端。
 * 验 Supabase 登录 → 建订单(service-role) → 用 #51 签名生成 chpay 参数 → 返回给客户端 form POST 跳转。
 * 商户私钥只活在本函数 env，客户端永不持有。
 *
 * 部署：supabase functions deploy pay-create
 * secrets：CHPAY_PID / CHPAY_MERCHANT_PRIVATE_KEY / CHPAY_API_URL(默认 outh.runacase.com 提交端点)
 *         / CHPAY_RETURN_URL（支付完成跳回页）；SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 平台注入
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildCreateOrderParams } from '../../../server/chpay/sign.ts'

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

    const { kind, amount_cents, credits, plan, pay_type } = (await req.json()) as {
      kind: 'credits' | 'membership'
      amount_cents: number
      credits?: number
      plan?: string
      pay_type: 'alipay' | 'wxpay'
    }
    if (!amount_cents || amount_cents < 100) return json({ error: '最低 ¥1' }, 400)
    if (!['alipay', 'wxpay'].includes(pay_type)) return json({ error: '不支持的支付方式' }, 400)
    if (!['credits', 'membership'].includes(kind)) return json({ error: '非法订单类型' }, 400)

    // 内部订单号（函数内可用 Date/crypto）
    const ts = Math.floor(Date.now() / 1000)
    const rand = crypto.randomUUID().slice(0, 8)
    const outTradeNo = `E${ts}${rand}`.toUpperCase()

    const { error: insErr } = await admin.from('orders').insert({
      out_trade_no: outTradeNo,
      user_id: user.id,
      amount_cents,
      kind,
      credits: kind === 'credits' ? credits ?? 0 : null,
      plan: kind === 'membership' ? plan ?? null : null,
      pay_type,
      status: 'pending'
    })
    if (insErr) return json({ error: '创建订单失败' }, 500)

    const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')
    const params = buildCreateOrderParams(
      {
        pid: Deno.env.get('CHPAY_PID') ?? '',
        payType: pay_type,
        outTradeNo,
        amountCents: amount_cents,
        notifyUrl: `${base}/functions/v1/pay-notify`,
        returnUrl: Deno.env.get('CHPAY_RETURN_URL') ?? `${base}/functions/v1/pay-query`,
        name: 'eshell',
        timestampSec: ts
      },
      Deno.env.get('CHPAY_MERCHANT_PRIVATE_KEY') ?? ''
    )

    return json({
      out_trade_no: outTradeNo,
      pay_url: Deno.env.get('CHPAY_API_URL') ?? 'https://outh.runacase.com/api/pay/submit',
      pay_params: params
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
