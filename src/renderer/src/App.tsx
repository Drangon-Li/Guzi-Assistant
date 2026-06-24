import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParseSummary, Profile, TaskRecord } from '@shared/types'
import { api } from './api'
import { supabase, functionsBase } from './supabase'
import { formatHotkey, summaryToast } from './labels'
import Onboarding from './pages/Onboarding'
import ScreenPermissionGate from './pages/ScreenPermissionGate'
import FloatingAssistant from './components/FloatingAssistant'
import Timeline from './pages/Timeline'
import Schedule from './pages/Schedule'
import Memory from './pages/Memory'
import Account from './pages/Account'
import Settings from './pages/Settings'
import PreviewCard from './pages/PreviewCard'
import Debug from './pages/Debug'
import PetChat from './pages/PetChat'
import brandMark from './assets/agent-avatar.png'
import brandWordmark from './assets/brand-wordmark.png'

type Page = 'timeline' | 'schedule' | 'memory' | 'account' | 'settings'

const NAV: { key: Page; label: string }[] = [
  { key: 'schedule', label: '日程' },
  { key: 'timeline', label: '时间轴' },
  { key: 'memory', label: '记忆' },
  { key: 'account', label: '个人' },
  { key: 'settings', label: '设置' }
]

export default function App(): React.JSX.Element {
  if (window.location.hash.includes('/preview')) return <PreviewCard />
  if (window.location.hash.includes('/debug')) return <Debug />
  if (window.location.hash.includes('/petchat')) return <PetChat />
  return <MainApp />
}

function MainApp(): React.JSX.Element | null {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [screenPerm, setScreenPerm] = useState<string | undefined>(undefined)
  const [screenGateSkipped, setScreenGateSkipped] = useState(false)
  const [page, setPage] = useState<Page>('schedule')
  const [chatOpen, setChatOpen] = useState(false)
  const [shownPage, setShownPage] = useState<Page>('schedule')
  const [pageVisible, setPageVisible] = useState(true)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hotkeyLabel, setHotkeyLabel] = useState('⌥ C')
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
    const push = (token: string | null): void => void api.setSession(functionsBase(), token)
    void supabase.auth.getSession().then(({ data }) => push(data.session?.access_token ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => push(s?.access_token ?? null))
    return () => sub.subscription.unsubscribe()
  }, [])

  // 首启屏幕录制授权 gate：查当前权限状态（仅 macOS 可能非 granted）
  useEffect(() => {
    void api.permissions().then((p) => setScreenPerm(p.screen))
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
      if (route === 'inbox' || route === 'assistant') setChatOpen(true)
      else if (
        route === 'timeline' ||
        route === 'schedule' ||
        route === 'memory' ||
        route === 'account' ||
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

  // 切页过渡：先淡出旧页，再换页并淡入新页
  useEffect(() => {
    if (page === shownPage) return
    setPageVisible(false)
    const t = window.setTimeout(() => {
      setShownPage(page)
      setPageVisible(true)
    }, 150)
    return () => window.clearTimeout(t)
  }, [page, shownPage])

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

  if (profile === undefined)
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="size-6 animate-spin rounded-full border-2 border-slate-700 border-t-transparent" />
      </div>
    )
  if (profile === null) return <Onboarding onDone={setProfile} />
  if (screenPerm === undefined)
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="size-6 animate-spin rounded-full border-2 border-slate-700 border-t-transparent" />
      </div>
    )
  if (screenPerm !== 'granted' && !screenGateSkipped)
    return <ScreenPermissionGate onDone={() => setScreenGateSkipped(true)} />

  return (
    <div
      className="flex h-full bg-canvas text-slate-800"
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
      <div className="drag-strip" />
      <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200/60 bg-canvas">
        <div className="px-5 pt-10 pb-4 titlebar-pad">
          <div className="flex items-center gap-2">
            <img src={brandMark} alt="" className="size-7 shrink-0" />
            <img src={brandWordmark} alt="纸壳助手" className="brand-wordmark h-5 w-auto" />
          </div>
          <div className="mt-1.5 text-xs text-slate-400">个人事项捕获助手</div>
        </div>
        <nav className="stagger flex flex-col gap-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                page === item.key ? 'bg-slate-100 font-medium text-slate-900' : 'hover:bg-slate-50'
              }`}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="mt-auto px-5 pb-5 text-[11px] leading-5 text-slate-400">
          复制内容后按 {hotkeyLabel}，快速提交剪切板。
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={`transition-opacity duration-150 ${pageVisible ? 'opacity-100' : 'opacity-0'}`}>
          {shownPage === 'timeline' && <Timeline tasks={tasks} />}
          {shownPage === 'schedule' && (
            <Schedule
              tasks={tasks}
              hotkeyLabel={hotkeyLabel}
              onOpenAssistant={() => setChatOpen(true)}
            />
          )}
          {shownPage === 'memory' && <Memory />}
          {shownPage === 'account' && <Account onProfileChange={setProfile} />}
          {shownPage === 'settings' && <Settings onProfileChange={setProfile} />}
        </div>
      </main>

      <FloatingAssistant
        open={chatOpen}
        onOpenChange={setChatOpen}
        tasks={tasks}
        showToast={showToast}
        hotkeyLabel={hotkeyLabel}
        userName={profile.name}
      />

      {dragging && (
        <div className="animate-overlay-in pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[#0f172a]/5 backdrop-blur-[1px]">
          <div className="animate-modal-in rounded-xl border-2 border-dashed border-slate-300 bg-surface px-8 py-6 text-slate-600 shadow-lg">
            松开以提交文件（图片 / PDF / docx / txt）
          </div>
        </div>
      )}

      {toast && (
        <div
          key={toast}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm text-white shadow-lg"
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
