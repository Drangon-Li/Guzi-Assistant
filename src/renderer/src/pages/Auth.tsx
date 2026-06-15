import { useState } from 'react'
import { supabase } from '../supabase'

/**
 * 登录 / 注册页（#69）——「注册登录即用」的入口，首启动门面。
 * 走设计稿组件系统（.ob-card / .field / .btn，发丝边、柔灰、细字重、留白），与引导页同语言。
 * 仅常规邮箱密码；Google/微信日后再加。登录成功由 App 的 onAuthStateChange 接管切换。
 */
export default function Auth({ onSkip }: { onSkip: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const submit = async (): Promise<void> => {
    if (!supabase || !email.trim() || !password) return
    setBusy(true)
    setMsg('')
    try {
      const { error } =
        mode === 'login'
          ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
          : await supabase.auth.signUp({ email: email.trim(), password })
      if (error) setMsg(error.message)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="animate-page flex h-full items-center justify-center"
      style={{ background: 'var(--surface)' }}
    >
      <div className="ob-card animate-card-in" style={{ maxWidth: 380 }}>
        <div className="h">{mode === 'login' ? '登录 EShell' : '创建账号'}</div>
        <div className="p">
          登录后即可使用云端 AI——自动从截图 / 剪贴板 / 文件里拎出该办的事。失败不扣、用尽自动停。
        </div>

        <div className="stagger mt-6 flex flex-col gap-3.5">
          <div className="field">
            <span>邮箱</span>
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="至少 6 位"
            />
          </div>
          <button
            className="btn btn-primary mt-1 w-full"
            style={{ padding: '9px 14px' }}
            disabled={busy || !email.trim() || !password}
            onClick={() => void submit()}
          >
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
          {msg && (
            <p className="text-center text-[11.5px] leading-5" style={{ color: 'var(--warn)' }}>
              {msg}
            </p>
          )}
        </div>

        <div className="mt-5 text-center text-[12px]" style={{ color: 'var(--t3)' }}>
          {mode === 'login' ? '还没有账号？' : '已有账号？'}
          <button
            className="ml-1 font-medium hover:underline"
            style={{ color: 'var(--t1)' }}
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setMsg('')
            }}
          >
            {mode === 'login' ? '注册' : '登录'}
          </button>
        </div>
      </div>

      <button
        className="fixed bottom-7 text-[11.5px] hover:underline"
        style={{ color: 'var(--t4)' }}
        onClick={onSkip}
      >
        暂不登录，先随便看看
      </button>
    </div>
  )
}
