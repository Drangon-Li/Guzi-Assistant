import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParseSummary, Profile, TaskRecord } from '@shared/types'
import { api } from './api'
import { supabase, functionsBase, hasBackend } from './supabase'
import { formatHotkey, summaryToast } from './labels'
import Onboarding from './pages/Onboarding'
import Auth from './pages/Auth'
import Assistant from './pages/Assistant'
import Timeline from './pages/Timeline'
import Schedule from './pages/Schedule'
import Memory from './pages/Memory'
import Settings from './pages/Settings'
import PreviewCard from './pages/PreviewCard'

type Page = 'assistant' | 'timeline' | 'schedule' | 'memory' | 'settings'

/** 细线图标（设计稿 D5：1.5 描边、无填充），viewBox 24。 */
const ICON: Record<Page, React.JSX.Element> = {
  assistant: (
    <path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 8.5 8.5 0 0 1-3.8-.9L3 20l1.9-4.2A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
  ),
  timeline: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  schedule: (
    <>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 2.5v4M16 2.5v4" />
    </>
  ),
  memory: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  )
}

const NAV: { key: Page; label: string }[] = [
  { key: 'assistant', label: '助手' },
  { key: 'timeline', label: '时间轴' },
  { key: 'schedule', label: '日程' },
  { key: 'memory', label: '记忆' },
  { key: 'settings', label: '设置' }
]

export default function App(): React.JSX.Element {
  if (window.location.hash.includes('/preview')) return <PreviewCard />
  return <MainApp />
}

function MainApp(): React.JSX.Element | null {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [page, setPage] = useState<Page>('assistant')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hotkeyLabel, setHotkeyLabel] = useState('⌥ C')
  const [signedIn, setSignedIn] = useState(false)
  const [authReady, setAuthReady] = useState(!hasBackend)
  const toastTimer = useRef<number | undefined>(undefined)
  const dragDepth = useRef(0)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4500)
  }, [])

  const refresh = useCallback(() => {
    void api.listTasks().then(setTasks)
  }, [])

  // #70：把 Supabase 登录态(functionsBase + token)推给主进程，供 parser 调 parse 网关
  useEffect(() => {
    if (!supabase) return
    const push = (token: string | null): void => {
      void api.setSession(functionsBase(), token)
      setSignedIn(!!token)
    }
    void supabase.auth.getSession().then(({ data }) => {
      push(data.session?.access_token ?? null)
      setAuthReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => push(s?.access_token ?? null))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    void api.getProfile().then(setProfile)
    refresh()
    const loadHotkey = (): void => {
      void api.getSettings().then((s) => setHotkeyLabel(formatHotkey(s.hotkey)))
    }
    loadHotkey()
    const offTasks = api.on('eshell:tasks-updated', refresh)
    const offSettings = api.on('eshell:settings-updated', loadHotkey)
    const offNav = api.on('eshell:navigate', (route) => {
      if (route === 'inbox' || route === 'assistant') setPage('assistant')
      else if (
        route === 'timeline' ||
        route === 'schedule' ||
        route === 'memory' ||
        route === 'settings'
      )
        setPage(route)
    })
    return () => {
      offTasks()
      offSettings()
      offNav()
    }
  }, [refresh])

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.eshell.pathForFile(f))
    if (!paths.length) return
    showToast(`正在解析 ${paths.length} 个文件…`)
    const results = await api.captureFiles(paths)
    showToast(filesToast(results))
  }

  if (profile === undefined || !authReady)
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="size-6 animate-spin rounded-full border-2 border-slate-700 border-t-transparent" />
      </div>
    )
  // 「注册登录即用」：未登录必须先登录/注册（登录成功 onAuthStateChange→signedIn 切走）。
  if (hasBackend && !signedIn) return <Auth />
  if (profile === null) return <Onboarding onDone={setProfile} />

  const pendingCount = tasks.filter((t) => t.status === 'pending').length

  return (
    <div
      className="flex h-full bg-[#fafafa] text-slate-800"
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0
          setDragging(false)
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <aside
        className="flex w-52 shrink-0 flex-col"
        style={{ borderRight: '1px solid var(--line)', background: 'var(--surface)' }}
      >
        <div className="px-5 pt-10 pb-4 titlebar-pad">
          <div className="text-base font-semibold tracking-tight" style={{ color: 'var(--t1)' }}>
            EShell
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: 'var(--t3)' }}>
            个人事项捕获助手
          </div>
        </div>
        <nav className="stagger flex flex-col gap-px px-2.5">
          {NAV.map((item) => {
            const active = page === item.key
            return (
              <button
                key={item.key}
                onClick={() => setPage(item.key)}
                className="flex items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13px] transition-colors"
                style={{
                  color: active ? 'var(--t1)' : 'var(--t2)',
                  fontWeight: active ? 500 : 400,
                  background: active ? 'var(--selected)' : 'transparent'
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = 'var(--hover)'
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent'
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-[17px] shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ opacity: 0.85 }}
                >
                  {ICON[item.key]}
                </svg>
                <span className="flex-1">{item.label}</span>
                {item.key === 'assistant' && pendingCount > 0 && (
                  <span
                    className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1.5 text-[10px] leading-none text-white"
                    style={{ background: 'var(--primary)' }}
                  >
                    {pendingCount}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
        <div className="mt-auto px-5 pb-5 text-[11px] leading-5 text-slate-400">
          复制内容后按 {hotkeyLabel}，快速提交剪切板。
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div key={page} className={page === 'assistant' ? 'animate-page h-full' : 'animate-page'}>
          {page === 'assistant' && (
            <Assistant
              tasks={tasks}
              showToast={showToast}
              hotkeyLabel={hotkeyLabel}
              userName={profile.name}
            />
          )}
          {page === 'timeline' && <Timeline tasks={tasks} />}
          {page === 'schedule' && <Schedule tasks={tasks} />}
          {page === 'memory' && <Memory />}
          {page === 'settings' && <Settings onProfileChange={setProfile} />}
        </div>
      </main>

      {dragging && (
        <div className="animate-overlay-in pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-slate-900/5 backdrop-blur-[1px]">
          <div className="animate-modal-in rounded-xl border-2 border-dashed border-slate-300 bg-white px-8 py-6 text-slate-600 shadow-lg">
            松开以提交文件（图片 / PDF / docx / txt）
          </div>
        </div>
      )}

      {toast && (
        <div
          key={toast}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  )
}

function filesToast(results: ParseSummary[]): string {
  if (results.length === 1) return summaryToast(results[0])
  const related = results.reduce((n, r) => n + r.related, 0)
  const errors = results.filter((r) => r.error)
  let msg = `${results.length} 个文件解析完成，共发现 ${related} 个相关事项`
  if (errors.length) msg += `；${errors.length} 个失败（${errors[0].error}）`
  return msg
}
