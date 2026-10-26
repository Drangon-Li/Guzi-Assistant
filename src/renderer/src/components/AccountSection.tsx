import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSubscriptionActive, planById, shouldRemindRenew } from '@shared/subscription'
import { supabase, hasBackend } from '../supabase'
import SubscribePanel from './SubscribePanel'
import Modal from './Modal'
import { useExitParticipant } from '../exit-lifecycle'

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

interface SubState {
  plan: string
  expiresAtMs: number
}

/** 头像统一裁成 128px 方形 JPEG data URL（约 5-8KB），直接存 profiles.avatar，免 Storage 桶。 */
async function fileToAvatar(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  // cover 裁剪：取原图中心正方形
  const side = Math.min(bmp.width, bmp.height)
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size)
  bmp.close()
  return canvas.toDataURL('image/jpeg', 0.85)
}

/**
 * #69 账号体系：登录/注册 + 账户资料自助管理（头像/昵称/邮箱/密码）+ 订阅状态。
 * 头像与昵称存 profiles（列级权限只放行这两列）；邮箱/密码走 Supabase Auth（改邮箱需邮件确认）。
 */
export default function AccountSection(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [sub, setSub] = useState<SubState | null>(null)
  const [avatar, setAvatar] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [dialog, setDialog] = useState<'subscribe' | 'email' | 'password' | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useExitParticipant({ id: 'account-login', label: '账户中有尚未提交的输入', canSave: false,
    isDirty: () => (!session && !!(email.trim() || password)) || editingName,
    prepare: async () => { setEmail(''); setPassword(''); setEditingName(false) } })
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadAccount = useCallback(async (): Promise<void> => {
    if (!supabase || !session) {
      setSub(null)
      setAvatar(null)
      setDisplayName('')
      return
    }
    const uid = session.user.id
    const [{ data: s }, { data: p }] = await Promise.all([
      supabase.from('subscriptions').select('plan, expires_at').eq('user_id', uid).single(),
      supabase.from('profiles').select('display_name, avatar').eq('id', uid).single()
    ])
    setSub(s ? { plan: s.plan, expiresAtMs: new Date(s.expires_at).getTime() } : null)
    setAvatar(p?.avatar ?? null)
    setDisplayName(p?.display_name ?? '')
  }, [session])

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  const flash = (m: string): void => {
    setMsg(m)
    window.setTimeout(() => setMsg(''), 4000)
  }

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
    const uid = session.user.id
    const now = Date.now()
    const active = isSubscriptionActive(sub?.expiresAtMs ?? null, now)
    const expireDay = sub ? new Date(sub.expiresAtMs).toISOString().slice(0, 10) : ''
    const planLabel = sub?.plan === 'trial' ? '试用' : planById(sub?.plan)?.label ?? '订阅'
    const remind = shouldRemindRenew(sub?.expiresAtMs ?? null, now)
    const statusText = !sub
      ? '—'
      : active
        ? `${planLabel} · 有效至 ${expireDay}${remind ? '（即将到期）' : ''}`
        : sub.plan === 'trial'
          ? '试用已结束'
          : '订阅已到期'

    const pickAvatar = async (file: File | undefined): Promise<void> => {
      if (!file) return
      try {
        const dataUrl = await fileToAvatar(file)
        const { error } = await sb.from('profiles').update({ avatar: dataUrl }).eq('id', uid)
        if (error) throw error
        setAvatar(dataUrl)
        flash('头像已更新')
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    }

    const saveName = async (): Promise<void> => {
      setEditingName(false)
      const name = displayName.trim()
      const { error } = await sb.from('profiles').update({ display_name: name || null }).eq('id', uid)
      flash(error ? error.message : '昵称已保存')
    }

    const actionBtn = 'rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50'

    return (
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-3">
          {/* 头像：点击更换（128px 方形，存 profiles，跨设备同步） */}
          <button
            className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-full"
            onClick={() => fileRef.current?.click()}
            title="更换头像"
          >
            {avatar ? (
              <img src={avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-brand text-lg font-semibold text-white">
                {(displayName || session.user.email || '?').slice(0, 1).toUpperCase()}
              </div>
            )}
            <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
              更换
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void pickAvatar(e.target.files?.[0])
              e.target.value = '' // 允许连续选同一文件
            }}
          />

          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                autoFocus
                className="w-44 rounded-md border border-slate-300 px-2 py-0.5 text-sm focus:outline-none"
                value={displayName}
                placeholder="给自己起个昵称"
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveName()
                  if (e.key === 'Escape') setEditingName(false)
                }}
              />
            ) : (
              <button
                className="group flex items-center gap-1.5 truncate text-left font-medium text-slate-700"
                onClick={() => setEditingName(true)}
                title="点击修改昵称"
              >
                {displayName || session.user.email}
                <span className="text-[10px] text-slate-300 opacity-0 transition-opacity group-hover:opacity-100">
                  编辑
                </span>
              </button>
            )}
            <div className="truncate text-xs text-slate-400">{session.user.email}</div>
            <div className={`text-xs ${active && !remind ? 'text-slate-400' : 'text-amber-600'}`}>
              {statusText}
            </div>
          </div>

          <button
            className="shrink-0 rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark"
            onClick={() => setDialog('subscribe')}
          >
            {active ? '续费订阅' : '立即订阅'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className={actionBtn} onClick={() => setDialog('email')}>
            修改邮箱
          </button>
          <button className={actionBtn} onClick={() => setDialog('password')}>
            修改密码
          </button>
          <button className={actionBtn} onClick={() => void sb.auth.signOut()}>
            退出登录
          </button>
        </div>

        {msg && <p className="text-xs text-emerald-600">{msg}</p>}

        {dialog === 'subscribe' && (
          <AccountModal title="订阅" onClose={() => setDialog(null)}>
            {() => <SubscribePanel onSubscribed={() => void loadAccount()} />}
          </AccountModal>
        )}
        {dialog === 'email' && (
          <AccountModal title="修改邮箱" onClose={() => setDialog(null)}>
            {(close) => (
              <ChangeEmailForm
                current={session.user.email ?? ''}
                onDone={(m) => {
                  close()
                  flash(m)
                }}
              />
            )}
          </AccountModal>
        )}
        {dialog === 'password' && (
          <AccountModal title="修改密码" onClose={() => setDialog(null)}>
            {(close) => (
              <ChangePasswordForm
                onDone={(m) => {
                  close()
                  flash(m)
                }}
              />
            )}
          </AccountModal>
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
      {mode === 'register' && (
        <p className="text-xs text-slate-400">注册即送 7 天全功能试用，到期前会提醒，不自动扣费。</p>
      )}
      {msg && <p className="text-xs leading-5 text-amber-700">{msg}</p>}
    </div>
  )
}

/** 账户区统一弹窗壳（复用全局 Modal 的动画与 Esc/遮罩关闭）。 */
function AccountModal({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: (close: () => void) => React.ReactNode
}): React.JSX.Element {
  return (
    <Modal panelClass="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl" onClose={onClose}>
      {(close) => (
        <>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{title}</h3>
            <button className="text-slate-400 hover:text-slate-600" onClick={close}>
              ✕
            </button>
          </div>
          {children(close)}
        </>
      )}
    </Modal>
  )
}

function ChangeEmailForm({
  current,
  onDone
}: {
  current: string
  onDone: (msg: string) => void
}): React.JSX.Element {
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useExitParticipant({ id: 'account-email', label: '邮箱修改尚未提交', canSave: false,
    isDirty: () => !!next.trim() && next.trim() !== current, prepare: async () => { setNext('') } })

  const submit = async (): Promise<void> => {
    const target = next.trim()
    if (!target || target === current) return
    setBusy(true)
    setErr('')
    const { error } = await supabase!.auth.updateUser({ email: target })
    setBusy(false)
    if (error) setErr(error.message)
    else onDone('确认邮件已发送，请到新邮箱完成确认后生效')
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-slate-400">
        当前邮箱：{current}。修改后需要到新邮箱点击确认链接才会生效。
      </p>
      <input
        className={input}
        placeholder="新邮箱地址"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
      />
      {err && <p className="text-xs text-red-500">{err}</p>}
      <button
        className="self-start rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
        disabled={busy || !next.trim() || next.trim() === current}
        onClick={() => void submit()}
      >
        {busy ? '提交中…' : '发送确认邮件'}
      </button>
    </div>
  )
}

function ChangePasswordForm({ onDone }: { onDone: (msg: string) => void }): React.JSX.Element {
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useExitParticipant({ id: 'account-password', label: '密码修改尚未提交', canSave: false,
    isDirty: () => !!(pw1 || pw2), prepare: async () => { setPw1(''); setPw2('') } })

  const submit = async (): Promise<void> => {
    if (pw1.length < 6) {
      setErr('密码至少 6 位')
      return
    }
    if (pw1 !== pw2) {
      setErr('两次输入不一致')
      return
    }
    setBusy(true)
    setErr('')
    const { error } = await supabase!.auth.updateUser({ password: pw1 })
    setBusy(false)
    if (error) setErr(error.message)
    else onDone('密码已更新')
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        className={input}
        type="password"
        placeholder="新密码（至少 6 位）"
        value={pw1}
        onChange={(e) => setPw1(e.target.value)}
      />
      <input
        className={input}
        type="password"
        placeholder="再输一遍"
        value={pw2}
        onChange={(e) => setPw2(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
      />
      {err && <p className="text-xs text-red-500">{err}</p>}
      <button
        className="self-start rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
        disabled={busy || !pw1 || !pw2}
        onClick={() => void submit()}
      >
        {busy ? '提交中…' : '确认修改'}
      </button>
    </div>
  )
}
