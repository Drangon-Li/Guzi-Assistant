import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParseSummary, Profile, TaskRecord } from '@shared/types'
import { shouldRemindRenew } from '@shared/subscription'
import { api } from './api'
import { supabase, functionsBase } from './supabase'
import { formatHotkey, summaryToast } from './labels'
import Onboarding from './pages/Onboarding'
import Welcome from './pages/Welcome'
import ScreenPermissionGate from './pages/ScreenPermissionGate'
import FloatingAssistant from './components/FloatingAssistant'
import Schedule from './pages/Schedule'
import Reports from './pages/Reports'
import Analysis from './pages/Analysis'
import History from './pages/History'
import Home from './pages/Home'
import Account from './pages/Account'
import Settings from './pages/Settings'
import PreviewCard from './pages/PreviewCard'
import ReminderCard from './pages/ReminderCard'
import Debug from './pages/Debug'
import PetChat from './pages/PetChat'
import QuickBar from './pages/QuickBar'
import brandMark from './assets/agent-avatar.png'
import {
  IconAccount,
  IconAnalysis,
  IconHistory,
  IconReport,
  IconSchedule,
  IconSettings,
  IconToday
} from './components/nav-icons'

type Page = 'home' | 'schedule' | 'reports' | 'analysis' | 'history' | 'account' | 'settings'

const WELCOME_KEY = 'guzi-assistant:welcomed'
const LEGACY_WELCOME_KEY = 'eshell:welcomed'

// 设置不在主导航里，固定在侧边栏底部
const NAV: { key: Page; label: string; icon: () => React.JSX.Element }[] = [
  { key: 'home', label: '今日', icon: IconToday },
  { key: 'schedule', label: '日程', icon: IconSchedule },
  { key: 'reports', label: '日报', icon: IconReport },
  { key: 'analysis', label: '分析', icon: IconAnalysis },
  { key: 'history', label: '历史', icon: IconHistory },
  { key: 'account', label: '个人', icon: IconAccount }
]

export default function App(): React.JSX.Element {
  if (window.location.hash.includes('/preview')) return <PreviewCard />
  if (window.location.hash.includes('/reminder')) return <ReminderCard />
  if (window.location.hash.includes('/debug')) return <Debug />
  if (window.location.hash.includes('/petchat')) return <PetChat />
  if (window.location.hash.includes('/quickbar')) return <QuickBar />
  return <MainApp />
}

function MainApp(): React.JSX.Element | null {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [screenPerm, setScreenPerm] = useState<string | undefined>(undefined)
  const [screenGateSkipped, setScreenGateSkipped] = useState(false)
  const [page, setPage] = useState<Page>('home')
  const [chatOpen, setChatOpen] = useState(false)
  const [shownPage, setShownPage] = useState<Page>('home')
  const [welcomed, setWelcomed] = useState(
    () =>
      window.localStorage.getItem(WELCOME_KEY) === '1' ||
      window.localStorage.getItem(LEGACY_WELCOME_KEY) === '1'
  )
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

  // 订阅/试用到期前 3 天：让桌宠主动提醒一次（否则到期像故障——用户走查 P0）
  useEffect(() => {
    if (!supabase) return
    const sb = supabase
    void sb.auth.getSession().then(async ({ data }) => {
      const uid = data.session?.user.id
      if (!uid) return
      const { data: s } = await sb
        .from('subscriptions')
        .select('plan, expires_at')
        .eq('user_id', uid)
        .single()
      if (!s) return
      const expiresMs = new Date(s.expires_at).getTime()
      if (shouldRemindRenew(expiresMs, Date.now())) {
        const days = Math.max(1, Math.ceil((expiresMs - Date.now()) / 86_400_000))
        void api.remindRenew(s.plan === 'trial' ? 'trial' : 'paid', days)
      }
    })
  }, [])

  useEffect(() => {
    void api.getProfile().then(setProfile)
    refresh()
    const loadHotkey = (): void => {
      void api.getSettings().then((s) => setHotkeyLabel(formatHotkey(s.hotkey)))
    }
    loadHotkey()
    const offTasks = api.on('guzi-assistant:tasks-updated', refresh)
    const offSettings = api.on('guzi-assistant:settings-updated', loadHotkey)
    const offNav = api.on('guzi-assistant:navigate', (route) => {
      if (route === 'inbox' || route === 'assistant') setChatOpen(true)
      else if (route === 'timeline')
        setPage('schedule') // 旧路由兼容：时间轴已并入日程页
      else if (route === 'memory')
        setPage('account') // 旧路由兼容：记忆页已拆解，个人记忆并入个人页
      else if (
        route === 'home' ||
        route === 'schedule' ||
        route === 'reports' ||
        route === 'analysis' ||
        route === 'history' ||
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
    const paths = Array.from(e.dataTransfer.files).map((f) => window.guziAssistant.pathForFile(f))
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
  if (profile === null) {
    // 首次运行：先过一遍产品引导，再进档案设置
    if (!welcomed)
      return (
        <Welcome
          onDone={() => {
            window.localStorage.setItem(WELCOME_KEY, '1')
            setWelcomed(true)
          }}
        />
      )
    return <Onboarding onDone={setProfile} />
  }
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
            {/* 品牌字标暂用文字渲染，避免旧「纸壳助手」图片继续出现在界面中。 */}
            <span className="text-[17px] font-semibold tracking-wide">谷子助手</span>
          </div>
          <div className="mt-1.5 text-xs text-slate-400">个人事项捕获助手</div>
        </div>
        <nav className="stagger flex flex-col gap-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                page === item.key
                  ? 'bg-brand-soft font-medium text-brand'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <item.icon />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-3 pb-5">
          <button
            onClick={() => setPage('settings')}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              page === 'settings'
                ? 'bg-brand-soft font-medium text-brand'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <IconSettings />
            <span>设置</span>
          </button>
          <div className="px-2 text-[11px] leading-5 text-slate-400">
            复制内容后按 {hotkeyLabel}，快速提交剪切板。
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={`transition-opacity duration-150 ${pageVisible ? 'opacity-100' : 'opacity-0'}`}>
          {shownPage === 'home' && <Home tasks={tasks} userName={profile.name} onNavigate={setPage} />}
          {shownPage === 'schedule' && (
            <Schedule
              tasks={tasks}
              hotkeyLabel={hotkeyLabel}
              onOpenAssistant={() => setChatOpen(true)}
            />
          )}
          {shownPage === 'reports' && <Reports />}
          {shownPage === 'analysis' && <Analysis />}
          {shownPage === 'history' && <History />}
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
