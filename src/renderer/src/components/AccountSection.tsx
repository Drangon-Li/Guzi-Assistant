import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, hasBackend } from '../supabase'
import RechargePanel from './RechargePanel'

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

/** #69 账号体系：登录/注册/登出 + 积分余额。托管解析(#39)与充值(#41)的前提。 */
export default function AccountSection(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [balance, setBalance] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showRecharge, setShowRecharge] = useState(false)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadBalance = useCallback(async (): Promise<void> => {
    if (!supabase || !session) {
      setBalance(null)
      return
    }
    const { data } = await supabase
      .from('credits')
      .select('grant_balance, purchased_balance')
      .eq('user_id', session.user.id)
      .single()
    setBalance(data ? data.grant_balance + data.purchased_balance : null)
  }, [session])

  useEffect(() => {
    void loadBalance()
  }, [loadBalance])

  if (!hasBackend || !supabase) {
    return <p className="text-xs leading-5 text-slate-400">托管服务未接入（本版本未配置后端）。</p>
  }
  const sb = supabase // 守卫后捕获非空，供下方闭包用（避免 TS 跨闭包丢失收窄）

  const submit = async (): Promise<void> => {
    if (!email.trim() || !password) return
    setBusy(true)
    setMsg('')
    try {
      const fn =
        mode === 'login'
          ? sb.auth.signInWithPassword({ email: email.trim(), password })
          : sb.auth.signUp({ email: email.trim(), password })
      const { error } = await fn
      if (error) setMsg(error.message)
      else if (mode === 'register') setMsg('注册成功，请查收验证邮件后登录')
    } finally {
      setBusy(false)
    }
  }

  if (session) {
    const initial = (session.user.email ?? '?').slice(0, 1).toUpperCase()
    return (
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-base font-semibold text-white">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-slate-700">{session.user.email}</div>
            <div className="text-xs text-slate-400">
              积分余额：
              {balance == null ? '—' : <span className="font-medium text-slate-600">{balance}</span>}
            </div>
          </div>
          <button
            className="shrink-0 rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50"
            onClick={() => void sb.auth.signOut()}
          >
            退出登录
          </button>
        </div>
        <div>
          <button
            className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark"
            onClick={() => setShowRecharge(true)}
          >
            充值积分
          </button>
        </div>
        {showRecharge && (
          <div
            className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
            onClick={() => setShowRecharge(false)}
          >
            <div
              className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold">充值积分</h3>
                <button
                  className="text-slate-400 hover:text-slate-600"
                  onClick={() => setShowRecharge(false)}
                >
                  ✕
                </button>
              </div>
              <RechargePanel onRecharged={() => void loadBalance()} />
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <input className={input} placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          className={input}
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
          disabled={busy || !email.trim() || !password}
          onClick={() => void submit()}
        >
          {mode === 'login' ? '登录' : '注册'}
        </button>
        <button
          className="text-xs text-slate-400 hover:text-slate-600"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setMsg('')
          }}
        >
          {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
        </button>
      </div>
      {msg && <p className="text-xs leading-5 text-amber-700">{msg}</p>}
    </div>
  )
}
