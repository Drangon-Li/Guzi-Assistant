import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, hasBackend } from '../supabase'
import { api } from '../api'
import RechargePanel from './RechargePanel'
import Modal from './Modal'

/** #69 账号体系：登录/注册/登出 + 积分余额。托管解析(#39)与充值(#41)的前提。 */
export default function AccountSection(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [balance, setBalance] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showRecharge, setShowRecharge] = useState(false)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // 档案里的真实姓名 → 账户卡用户名（设计稿 .who .n）；档案更新时主进程会广播
  useEffect(() => {
    const load = (): void => {
      void api.getProfile().then((p) => setName(p?.name?.trim() ?? ''))
    }
    load()
    return api.on('eshell:tasks-updated', load) // 保存档案后无专用事件，沿用刷新触发轻量重读
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

  // 解析扣费后主进程广播最新余额 → 即时刷新（#71 心安：用户看得到扣了多少）
  useEffect(() => {
    return api.on('eshell:balance-updated', (b) => {
      if (typeof b === 'number') setBalance(b)
    })
  }, [])

  if (!hasBackend || !supabase) {
    return (
      <p className="text-[11.5px] leading-5" style={{ color: 'var(--t3)' }}>
        托管服务未接入（本版本未配置后端）。
      </p>
    )
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
      else if (mode === 'register') setMsg('注册成功，已自动登录')
    } finally {
      setBusy(false)
    }
  }

  if (session) {
    const em = session.user.email ?? ''
    const displayName = name || em.split('@')[0] || '我'
    const avatarChar = (name || em || 'U').trim()[0]?.toUpperCase() ?? 'U'
    const approxRuns = balance == null ? null : balance // 1 积分≈1 次文本解析
    return (
      <>
        <div className="acct">
          <div className="av">{avatarChar}</div>
          <div className="who">
            <div className="n">{displayName}</div>
            <div className="e">{em}</div>
            <div className="balance">
              <span className="v">{balance == null ? '—' : balance}</span>
              <span className="u">积分{approxRuns != null && ` · 约 ${approxRuns} 次解析`}</span>
            </div>
          </div>
          <button className="btn primary sm" onClick={() => setShowRecharge(true)}>
            充值
          </button>
        </div>
        <p className="desc" style={{ margin: '12px 0 0' }}>
          解析能力由 EShell 云端提供，开箱即用，无需配置任何模型或密钥。
        </p>
        <div className="mt-3 flex justify-end">
          <button
            className="text-[11.5px] hover:underline"
            style={{ color: 'var(--t3)' }}
            onClick={() => void sb.auth.signOut()}
          >
            退出登录
          </button>
        </div>
        {showRecharge && (
          <Modal
            panelClass="w-[420px] rounded-[14px] bg-white p-5 shadow-[0_24px_70px_-10px_#0f172a55]"
            onClose={() => setShowRecharge(false)}
          >
            {(close) => (
              <div className="flex flex-col gap-4">
                <h3 className="text-[15px] font-semibold" style={{ color: 'var(--t1)' }}>
                  充值
                </h3>
                <RechargePanel onRecharged={() => void loadBalance()} />
                <button className="btn ghost sm self-center" onClick={close}>
                  关闭
                </button>
              </div>
            )}
          </Modal>
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid2">
        <div className="field">
          <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={busy || !email.trim() || !password}
          onClick={() => void submit()}
        >
          {mode === 'login' ? '登录' : '注册'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setMsg('')
          }}
        >
          {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
        </button>
      </div>
      {msg && (
        <p className="text-[11.5px] leading-5" style={{ color: 'var(--warn)' }}>
          {msg}
        </p>
      )}
    </div>
  )
}
