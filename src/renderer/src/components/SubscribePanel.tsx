import { useEffect, useRef, useState } from 'react'
import { PLANS, type PlanId } from '@shared/subscription'
import { callFunction } from '../supabase'
import { api } from '../api'

/**
 * 订阅面板（原充值面板，积分制 → 订阅制）：选档位 + 支付方式 → pay-create（服务端按档位白名单
 * 定价，客户端不传金额）→ 开支付窗(chpay 表单 POST) → 轮询 pay-query 到 paid → 关窗刷新状态。
 * chpay 无代扣：订阅是手动续费的时长卡，续费在当前到期时间上叠加。
 */

type PayType = 'alipay' | 'wxpay'

const yuan = (cents: number): string => `¥${(cents / 100).toFixed(2)}`
const PLAN_LIST = Object.values(PLANS)

export default function SubscribePanel({ onSubscribed }: { onSubscribed: () => void }): React.JSX.Element {
  const [plan, setPlan] = useState<PlanId>('monthly')
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

  const subscribe = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      const order = await callFunction<{ out_trade_no: string; pay_url: string; pay_params: Record<string, string> }>(
        '/pay-create',
        { method: 'POST', body: JSON.stringify({ plan, pay_type: payType }) }
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
              setMsg('订阅成功，有效期已更新 🎉')
              setBusy(false)
              onSubscribed()
              return // 命中即收尾，别让下面的超时分支覆盖成功提示
            }
          } catch {
            // 单次查询失败忽略，继续轮询
          }
          if (tries >= 60) {
            stopPoll()
            setMsg('未检测到支付完成；若已付款，稍后刷新即可。')
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

  const planCls = (selected: boolean): string =>
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
        {PLAN_LIST.map((p) => (
          <button key={p.id} className={planCls(plan === p.id)} onClick={() => setPlan(p.id)}>
            <span className="font-medium text-slate-700">{p.label}</span>
            <span className="text-slate-500">
              {yuan(p.amountCents)} / {p.days} 天
            </span>
            {p.tag && <span className="text-[10px] text-emerald-600">{p.tag}</span>}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-4 text-slate-400">
        订阅期内不限次使用（含每日公平用量上限）。到期前会提醒续费；续费时长在当前有效期上叠加，不吃亏。
      </p>

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
          className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
          disabled={busy}
          onClick={() => void subscribe()}
        >
          {busy ? '等待支付…' : '立即订阅'}
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
