import { useEffect, useRef, useState } from 'react'
import { callFunction } from '../supabase'
import { api } from '../api'

/**
 * #71 充值 UI：选积分包 / 会员 + 支付方式 → 调 pay-create 网关 → 开支付窗(chpay 表单 POST) →
 * 轮询 pay-query 到 paid → 关窗 + 刷新余额。金额内部用「分」，对用户展示「元」。
 * 价格按 #56 设计（单档会员 ¥19.9/月≈1000 分；积分包大额带少量赠送），数值后续可配。
 */

type Pack = { id: string; label: string; amountCents: number; credits: number; tag?: string }
const PACKS: Pack[] = [
  { id: 'c600', label: '600 积分', amountCents: 600, credits: 600 },
  { id: 'c2000', label: '2000 积分', amountCents: 1800, credits: 2000, tag: '多送 200' },
  { id: 'c3500', label: '3500 积分', amountCents: 3000, credits: 3500, tag: '多送 500' }
]
const MEMBERSHIP = { amountCents: 1990, plan: 'monthly', label: '会员 · ¥19.9/月', grant: 1000 }

type PayType = 'alipay' | 'wxpay'
type Choice = { kind: 'credits'; pack: Pack } | { kind: 'membership' }

const yuan = (cents: number): string => `¥${(cents / 100).toFixed(2)}`

export default function RechargePanel({ onRecharged }: { onRecharged: () => void }): React.JSX.Element {
  const [choice, setChoice] = useState<Choice>({ kind: 'credits', pack: PACKS[1] })
  const [payType, setPayType] = useState<PayType>('alipay')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 卸载时清轮询 + 关支付窗，避免泄漏
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      void api.closePayment()
    }
  }, [])

  const stopPoll = (): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const recharge = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      const payload =
        choice.kind === 'credits'
          ? {
              kind: 'credits',
              amount_cents: choice.pack.amountCents,
              credits: choice.pack.credits,
              pay_type: payType
            }
          : { kind: 'membership', amount_cents: MEMBERSHIP.amountCents, plan: MEMBERSHIP.plan, pay_type: payType }

      const order = await callFunction<{ out_trade_no: string; pay_url: string; pay_params: Record<string, string> }>(
        '/pay-create',
        { method: 'POST', body: JSON.stringify(payload) }
      )
      await api.openPayment(order.pay_url, order.pay_params)
      setMsg('已打开支付页，请扫码完成支付…')

      // 轮询订单状态（最长 ~3 分钟）
      let tries = 0
      stopPoll()
      pollRef.current = setInterval(() => {
        void (async () => {
          tries += 1
          try {
            const r = await callFunction<{ status?: string }>(
              `/pay-query?out_trade_no=${encodeURIComponent(order.out_trade_no)}`
            )
            if (r.status === 'paid') {
              stopPoll()
              await api.closePayment()
              setMsg('充值成功，积分已到账 🎉')
              setBusy(false)
              onRecharged()
              return // 命中即收尾，别让下面的超时分支覆盖成功提示（恰好第 60 次到账时）
            }
          } catch {
            // 单次查询失败忽略，继续轮询
          }
          if (tries >= 60) {
            stopPoll()
            setMsg('未检测到支付完成；若已付款，稍后刷新余额即可。')
            setBusy(false)
          }
        })()
      }, 3000)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const cancel = (): void => {
    stopPoll()
    void api.closePayment()
    setBusy(false)
    setMsg('')
  }

  const amountCents = choice.kind === 'credits' ? choice.pack.amountCents : MEMBERSHIP.amountCents

  const row = (
    sel: boolean,
    title: string,
    sub: string | undefined,
    price: string,
    bonus: boolean,
    onClick: () => void,
    key?: string
  ): React.JSX.Element => (
    <button
      key={key}
      onClick={onClick}
      className="flex items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors"
      style={{
        borderColor: sel ? 'var(--t2)' : 'var(--line-2)',
        background: sel ? 'var(--hover)' : 'var(--card)'
      }}
    >
      <span
        className="flex size-[15px] shrink-0 items-center justify-center rounded-full border"
        style={{
          borderColor: sel ? 'var(--primary)' : 'var(--line-3)',
          background: sel ? 'var(--primary)' : 'transparent'
        }}
      >
        {sel && <span className="size-1.5 rounded-full bg-white" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium" style={{ color: 'var(--t1)' }}>
          {title}
        </div>
        {sub && (
          <div className="mt-0.5 text-[11.5px]" style={{ color: bonus ? 'var(--okc)' : 'var(--t3)' }}>
            {sub}
          </div>
        )}
      </div>
      <div className="text-[13px] font-medium tabular-nums" style={{ color: 'var(--t1)' }}>
        {price}
      </div>
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {PACKS.map((p) =>
          row(
            choice.kind === 'credits' && choice.pack.id === p.id,
            p.label,
            p.tag,
            yuan(p.amountCents),
            true,
            () => setChoice({ kind: 'credits', pack: p }),
            p.id
          )
        )}
        {row(
          choice.kind === 'membership',
          '会员',
          `每月赠 ${MEMBERSHIP.grant} 积分 · 跨设备通用`,
          `${yuan(MEMBERSHIP.amountCents)}/月`,
          false,
          () => setChoice({ kind: 'membership' }),
          'membership'
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[11.5px]" style={{ color: 'var(--t3)' }}>
          支付方式
        </span>
        <div className="flex gap-1">
          {(['alipay', 'wxpay'] as const).map((pt) => (
            <button
              key={pt}
              onClick={() => setPayType(pt)}
              className="rounded-[7px] border px-3 py-1 text-[12px] transition-colors"
              style={{
                borderColor: payType === pt ? 'var(--t2)' : 'var(--line-2)',
                color: payType === pt ? 'var(--t1)' : 'var(--t3)'
              }}
            >
              {pt === 'alipay' ? '支付宝' : '微信'}
            </button>
          ))}
        </div>
      </div>

      <button
        className="btn btn-primary w-full"
        style={{ padding: '9px 14px' }}
        disabled={busy}
        onClick={() => void recharge()}
      >
        {busy ? '等待支付…' : `${payType === 'alipay' ? '支付宝' : '微信'}支付 ${yuan(amountCents)}`}
      </button>
      {busy && (
        <button className="btn btn-ghost btn-sm self-center" onClick={cancel}>
          取消
        </button>
      )}
      {msg && (
        <p className="text-center text-[11.5px] leading-5" style={{ color: 'var(--t2)' }}>
          {msg}
        </p>
      )}
    </div>
  )
}
