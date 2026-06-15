import { useState } from 'react'
import { supabase } from '../supabase'

/**
 * 登录 / 注册页（#69）——「注册登录即用」的入口，首启动门面。
 * 风格：克制、留白、单卡居中（参考海外通用 auth）。仅常规邮箱密码；Google/微信日后再加。
 * 登录成功由 App 的 onAuthStateChange 接管切换，无需本页跳转。
 */
const input =
  'w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none transition'

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
      // 成功：onAuthStateChange 会让 App 切走本页
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="animate-page flex h-full flex-col items-center justify-center bg-[#fafafa] px-6">
      <div className="stagger w-full max-w-[360px]">
        {/* 品牌 */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-[13px] bg-ink text-[15px] font-semibold text-white shadow-sm transition-transform duration-300 ease-[cubic-bezier(.2,.8,.2,1)] hover:scale-105">
            E
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {mode === 'login' ? '登录 EShell' : '创建账号'}
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-slate-500">
            登录后即可使用云端 AI——自动从截图 / 剪贴板 / 文件里拎出该办的事。
          </p>
        </div>

        {/* 表单卡片 */}
        <div
          key={mode}
          className="animate-card-in flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <input
            className={input}
            type="email"
            placeholder="邮箱"
            value={email}
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
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
          <button
            className="mt-1 w-full rounded-xl bg-ink py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:opacity-40"
            disabled={busy || !email.trim() || !password}
            onClick={() => void submit()}
          >
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
          {msg && <p className="text-center text-xs leading-5 text-amber-700">{msg}</p>}
        </div>

        {/* 切换 + 跳过 */}
        <div className="mt-5 text-center text-sm text-slate-500">
          {mode === 'login' ? '还没有账号？' : '已有账号？'}
          <button
            className="ml-1 font-medium text-slate-900 hover:underline"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setMsg('')
            }}
          >
            {mode === 'login' ? '注册' : '登录'}
          </button>
        </div>
        <div className="mt-8 text-center">
          <button className="text-xs text-slate-400 hover:text-slate-600" onClick={onSkip}>
            暂不登录，先随便看看
          </button>
        </div>
      </div>
    </div>
  )
}
