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

  const packCls = (selected: boolean): string =>
    `flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition ${
      selected ? 'border-ink ring-2 ring-ink/10' : 'border-slate-200 hover:border-slate-300'
    }`
  const payCls = (selected: boolean): string =>
    `rounded-lg border px-3 py-1 text-xs transition ${
      selected ? 'border-ink text-ink' : 'border-slate-200 text-slate-400 hover:text-slate-600'
    }`

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {PACKS.map((p) => {
          const selected = choice.kind === 'credits' && choice.pack.id === p.id
          return (
            <button key={p.id} className={packCls(selected)} onClick={() => setChoice({ kind: 'credits', pack: p })}>
              <span className="font-medium text-slate-700">{p.label}</span>
              <span className="text-slate-500">{yuan(p.amountCents)}</span>
              {p.tag && <span className="text-[10px] text-emerald-600">{p.tag}</span>}
            </button>
          )
        })}
      </div>

      <button
        className={packCls(choice.kind === 'membership')}
        onClick={() => setChoice({ kind: 'membership' })}
      >
        <span className="font-medium text-slate-700">{MEMBERSHIP.label}</span>
        <span className="text-slate-500">每月赠 {MEMBERSHIP.grant} 积分 · 跨设备通用</span>
      </button>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">支付方式</span>
        <button className={payCls(payType === 'alipay')} onClick={() => setPayType('alipay')}>
          支付宝
        </button>
        <button className={payCls(payType === 'wxpay')} onClick={() => setPayType('wxpay')}>
          微信
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          className="rounded-lg bg-ink px-4 py-1.5 text-xs text-white hover:bg-black disabled:opacity-40"
          disabled={busy}
          onClick={() => void recharge()}
        >
          {busy ? '等待支付…' : '充值'}
        </button>
        {busy && (
          <button className="text-xs text-slate-400 hover:text-slate-600" onClick={cancel}>
            取消
          </button>
        )}
      </div>
      {msg && <p className="text-xs leading-5 text-slate-500">{msg}</p>}
    </div>
  )
}
