import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, hasBackend } from '../supabase'
import { Section } from './ui'

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

/**
 * 联系我们（设置 → 关于）：应用内直接提交反馈——写入我方 Supabase feedback 表
 * （RLS：登录用户只能写/看自己的），团队后台可见，用户无需跳邮件/群。
 */
export default function FeedbackSection(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const submit = async (): Promise<void> => {
    const text = content.trim()
    if (!text || !supabase || !session) return
    setBusy(true)
    setMsg('')
    const { error } = await supabase.from('feedback').insert({
      user_id: session.user.id,
      content: text.slice(0, 2000),
      contact: contact.trim().slice(0, 100) || null,
      ua: navigator.userAgent
    })
    setBusy(false)
    if (error) {
      setMsg(`提交失败：${error.message}`)
      return
    }
    setContent('')
    setMsg('已收到，谢谢你的反馈！我们会认真看每一条。')
    window.setTimeout(() => setMsg(''), 5000)
  }

  return (
    <Section title="联系我们" desc="使用中的问题、建议、想要的功能，都可以在这里直接告诉我们。">
      {!hasBackend || !supabase ? (
        <p className="py-2 text-sm leading-6 text-slate-400">
          本地模式下没有应用内反馈通道。欢迎到 GitHub 仓库 Drangon-Li/Guzi-Assistant 的 Issues 提问题和建议；安全问题请按仓库里的 SECURITY.md 私密报告。
        </p>
      ) : !session ? (
        <p className="py-2 text-sm text-slate-400">登录后即可在应用内直接反馈（个人页 → 账户）。</p>
      ) : (
        <div className="flex flex-col gap-3">
          <textarea
            className={`${input} min-h-[110px] resize-y leading-6`}
            placeholder="说说你遇到的问题或想法，越具体我们改得越快…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <input
              className={`${input} max-w-xs`}
              placeholder="联系方式（选填：微信 / 邮箱 / QQ）"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
            <button
              className="shrink-0 rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
              disabled={busy || !content.trim()}
              onClick={() => void submit()}
            >
              {busy ? '提交中…' : '提交反馈'}
            </button>
          </div>
          {msg && <p className={`text-xs ${msg.startsWith('提交失败') ? 'text-red-500' : 'text-emerald-600'}`}>{msg}</p>}
        </div>
      )}
    </Section>
  )
}
