import { isMac } from './platform'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ParseSummary, Profile, TaskRecord } from '@shared/types'
import { shouldRemindRenew } from '@shared/subscription'
import { api } from './api'
import { isRecording, startCapture, stopCapture } from './voice-capture'
import { isExitPreparing, useExitParticipant } from './exit-lifecycle'
import type { VoiceSessionRecord } from '@shared/voicenotes'
import { supabase, functionsBase } from './supabase'
import { formatHotkey, summaryToast } from './labels'
import Onboarding from './pages/Onboarding'
import Welcome from './pages/Welcome'
import ScreenPermissionGate from './pages/ScreenPermissionGate'
import FloatingAssistant from './components/FloatingAssistant'
import Schedule from './pages/Schedule'
import Reports from './pages/Reports'
import Analysis from './pages/Analysis'
import Home from './pages/Home'
import Account from './pages/Account'
import Settings, { type SettingsCat } from './pages/Settings'
import Market from './pages/Market'
import brandMark from './assets/agent-avatar.png'
import {
  IconAccount,
  IconAnalysis,
  IconMarket,
  IconReport,
  IconSchedule,
  IconSettings,
  IconToday
} from './components/nav-icons'
import { PLUGINS } from '@shared/plugin-registry'
import { PLUGIN_UI } from './plugins'
import type { PluginRendererModule } from './plugins/types'

type CorePage = 'home' | 'schedule' | 'reports' | 'analysis' | 'account' | 'settings' | 'market'
/** 插件页的 key 就是插件 id，所以这里必须放宽到 string。 */
type Page = CorePage | string

const CORE_PAGES: readonly CorePage[] = [
  'home',
  'schedule',
  'reports',
  'analysis',
  'account',
  'settings',
  'market'
]

const WELCOME_KEY = 'guzi-assistant:welcomed'
const LEGACY_WELCOME_KEY = 'eshell:welcomed'

// 设置和市场不在主导航里，固定在侧边栏底部
const NAV: { key: CorePage; label: string; icon: () => React.JSX.Element }[] = [
  { key: 'home', label: '今日', icon: IconToday },
  { key: 'schedule', label: '日程', icon: IconSchedule },
  { key: 'reports', label: '日报', icon: IconReport },
  { key: 'analysis', label: '分析', icon: IconAnalysis },
  { key: 'account', label: '个人', icon: IconAccount }
]

const navItemClass = (active: boolean): string =>
  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
    active ? 'bg-brand-soft font-medium text-brand' : 'text-slate-600 hover:bg-slate-50'
  }`

/** 主窗口：侧栏导航 + 各页面 + 悬浮助手。独立小窗的路由在 App.tsx，不经过这里。 */
export default function MainApp(): React.JSX.Element | null {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [screenPerm, setScreenPerm] = useState<string | undefined>(undefined)
  const [screenGateSkipped, setScreenGateSkipped] = useState(false)
  const [page, setPage] = useState<Page>('home')
  // 深链到设置页的某个分区（首页「去设置开启」直接落到屏幕感知）。
  // 每次导航都重设：从侧栏进设置时传 undefined，才不会残留上一次的分区。
  const [settingsCat, setSettingsCat] = useState<SettingsCat | undefined>(undefined)
  const navigate = useCallback((next: Page, cat?: SettingsCat): void => {
    setSettingsCat(cat)
    setPage(next)
  }, [])
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
  const [hotkeyLabel, setHotkeyLabel] = useState(formatHotkey('Alt+C'))
  const [enabledPlugins, setEnabledPlugins] = useState<string[]>([])
  const toastTimer = useRef<number | undefined>(undefined)
  const dragDepth = useRef(0)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4500)
  }, [])

  // 已启用插件决定导航里多出哪几项。市场里改了就广播，这里跟着重算。
  useEffect(() => {
    const load = (): void => {
      void api.listPlugins().then((list) => {
        setEnabledPlugins(list.filter((s) => s.enabled).map((s) => s.manifest.id))
      })
    }
    load()
    return api.on('guzi-assistant:plugins-updated', load)
  }, [])

  // 正停在某个插件页时把它停用了：退回今日，否则会停在一个已经没人渲染的 key 上
  useEffect(() => {
    if (CORE_PAGES.includes(page as CorePage)) return
    if (!enabledPlugins.includes(page)) setPage('home')
  }, [enabledPlugins, page])

  // flatMap 而不是 map+filter：注册表是 as const，字面量类型和收窄谓词对不上，
  // 空数组表示「跳过」既省掉谓词也省掉 null 分支。
  const pluginNav = useMemo(
    () =>
      PLUGINS.filter((p) => enabledPlugins.includes(p.id))
        .flatMap((p) => {
          const mod: PluginRendererModule | undefined = PLUGIN_UI[p.id]
          if (!mod) return []
          const nav: { label: string; order: number } = p.contributes.nav
          return [{ key: p.id as string, label: nav.label, order: nav.order, Icon: mod.Icon }]
        })
        .sort((a, b) => a.order - b.order),
    [enabledPlugins]
  )

  const pluginHomeCards = useMemo(
    () =>
      PLUGINS.filter((p) => enabledPlugins.includes(p.id)).flatMap((p) => {
        const mod: PluginRendererModule | undefined = PLUGIN_UI[p.id]
        const names: readonly string[] =
          'homeCards' in p.contributes ? p.contributes.homeCards : []
        return names.flatMap((name) => {
          const Card = mod?.homeCards?.[name]
          return Card ? [{ key: name, Card: Card as React.ComponentType }] : []
        })
      }),
    [enabledPlugins]
  )

  const refresh = useCallback(() => {
    void api.listTasks().then((next) => setTasks((prev) => reconcileTasks(prev, next)))
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

  const voiceNeedsFinalizing = useRef(false)
  useExitParticipant({
    id: 'voice-capture', label: '语音纪要正在录制，保存将停止录音并完成转录',
    isDirty: () => isRecording() || voiceNeedsFinalizing.current,
    canDiscard: false,
    prepare: async () => {
      voiceNeedsFinalizing.current = true
      await stopCapture()
      await api.voiceStop()
      voiceNeedsFinalizing.current = false
      showToast('语音纪要已停止并保存；本次退出若取消，录音不会自动恢复')
    }
  })

  // 语音纪要：录音只能在渲染层做，主进程判定「该不该录」，这里跟着它的会话状态开关麦克风。
  // 挂在主窗而不是某个页面里——切页面不该把正在开的会掐掉。
  useEffect(() => {
    const sync = (session: VoiceSessionRecord | null): void => {
      if (session && session.status === 'recording') {
        if (isExitPreparing() || voiceNeedsFinalizing.current) return
        void startCapture(session.id).catch((e: unknown) => {
          showToast(`麦克风不可用：${e instanceof Error ? e.message : String(e)}`)
          void api.voiceStop()
        })
      } else {
        void stopCapture().then(async () => {
          if (session?.status === 'finalizing') await api.voiceCaptureStopped(session.id)
        }).catch((error: unknown) => showToast(`语音尚未保存：${error instanceof Error ? error.message : String(error)}`))
      }
    }
    void api.voiceState().then(sync)
    const off = api.on('guzi-assistant:voice-state', (s) => sync(s as VoiceSessionRecord | null))
    return () => {
      off()
      void stopCapture()
    }
  }, [showToast])

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
        navigate('schedule') // 旧路由兼容：时间轴已并入日程页
      else if (route === 'memory')
        navigate('account') // 旧路由兼容：记忆页已拆解，个人记忆并入个人页
      else if (route === 'history')
        navigate('reports') // 旧路由兼容：历史页已并入日报页的「活动明细」
      else if (typeof route === 'string' && CORE_PAGES.includes(route as CorePage)) navigate(route)
      // 插件页也能被导航到（桌宠气泡、提醒卡都可能想跳过去）；没启用就当没这条路由
      else if (typeof route === 'string' && PLUGINS.some((p) => p.id === route)) navigate(route)
    })
    return () => {
      offTasks()
      offSettings()
      offNav()
    }
  }, [refresh])

  // 切页过渡：旧页快速淡出，新页走 animate-page（淡入 + 轻微上移）。
  // 淡出压到 100ms——纯淡出没有信息量，拖长了只会让切页显得迟钝。
  useEffect(() => {
    if (page === shownPage) return
    setPageVisible(false)
    const t = window.setTimeout(() => {
      setShownPage(page)
      setPageVisible(true)
    }, 100)
    return () => window.clearTimeout(t)
  }, [page, shownPage])

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    // 收遮罩要排在最前：里层（如笔记正文接图片）可能已经接手，那时下面直接返回，
    // 但「松开以提交文件」这块蒙版无论如何都得收掉，否则会一直挂在界面上。
    dragDepth.current = 0
    setDragging(false)
    if (e.defaultPrevented) return
    e.preventDefault()
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
  if (isMac && screenPerm !== 'granted' && !screenGateSkipped)
    return <ScreenPermissionGate onDone={() => setScreenGateSkipped(true)} />

  // 非核心页 = 插件页。停用后 PLUGIN_UI 里仍有条目，所以还要看它在不在已启用集合里。
  const PluginPage =
    !CORE_PAGES.includes(shownPage as CorePage) && enabledPlugins.includes(shownPage)
      ? PLUGIN_UI[shownPage]?.Page
      : undefined

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
              className={navItemClass(page === item.key)}
            >
              <item.icon />
              <span>{item.label}</span>
            </button>
          ))}

          {/* 插件页单独一组：一条细线把「谷子助手自带的」和「你自己装的」分开，
              核心导航的顺序因此永远不会因为装了插件而改变 */}
          {pluginNav.length > 0 && (
            <>
              <div className="mx-3 my-1.5 border-t border-slate-200/70" />
              {pluginNav.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setPage(item.key)}
                  className={navItemClass(page === item.key)}
                >
                  <item.Icon />
                  <span>{item.label}</span>
                </button>
              ))}
            </>
          )}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-3 pb-5">
          <button onClick={() => setPage('market')} className={navItemClass(page === 'market')}>
            <IconMarket />
            <span>市场</span>
          </button>
          <button onClick={() => navigate('settings')} className={navItemClass(page === 'settings')}>
            <IconSettings />
            <span>设置</span>
          </button>
          <div className="px-2 text-[11px] leading-5 text-slate-400">
            复制内容后按 {hotkeyLabel}，快速提交剪切板。
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {/* key 换页即重挂，animate-page 才会重播（CSS animation 只在元素插入时跑一次）；
            切页本来就要换组件，重挂不额外损失状态 */}
        <div
          key={shownPage}
          className={pageVisible ? 'animate-page' : 'opacity-0 transition-opacity duration-100'}
        >
          {shownPage === 'home' && (
            <Home
              tasks={tasks}
              userName={profile.name}
              onNavigate={navigate}
              pluginCards={pluginHomeCards}
            />
          )}
          {shownPage === 'schedule' && (
            <Schedule
              tasks={tasks}
              hotkeyLabel={hotkeyLabel}
              onOpenAssistant={() => setChatOpen(true)}
            />
          )}
          {shownPage === 'reports' && <Reports />}
          {shownPage === 'analysis' && <Analysis />}
          {shownPage === 'account' && <Account onProfileChange={setProfile} />}
          {shownPage === 'settings' && <Settings onProfileChange={setProfile} initialCat={settingsCat} />}
          {shownPage === 'market' && <Market />}
          {/* 插件页：lazy 加载，没启用的插件不进首屏 chunk */}
          {PluginPage && (
            <Suspense
              fallback={
                <div className="flex h-64 items-center justify-center">
                  <div className="size-5 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                </div>
              }
            >
              <PluginPage enabledPlugins={enabledPlugins} />
            </Suspense>
          )}
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

/**
 * 主进程每次广播 tasks-updated 都重拉全表，拿回来的是一整批新对象——直接 setTasks 会让
 * 每一行的 memo 全部失效，勾一条任务要重渲染整张列表。这里逐条比对内容，没变的沿用旧引用；
 * 整批都没变则连 state 都不动（有些广播来自与任务无关的路径）。
 */
function reconcileTasks(prev: TaskRecord[], next: TaskRecord[]): TaskRecord[] {
  const before = new Map(prev.map((t) => [t.id, t]))
  let changed = prev.length !== next.length
  const merged = next.map((t, i) => {
    const old = before.get(t.id)
    if (old && JSON.stringify(old) === JSON.stringify(t)) {
      if (prev[i] !== old) changed = true // 内容没变但顺序变了，列表仍需重排
      return old
    }
    changed = true
    return t
  })
  return changed ? merged : prev
}

function filesToast(results: ParseSummary[]): string {
  if (results.length === 1) return summaryToast(results[0])
  const related = results.reduce((n, r) => n + r.related, 0)
  const errors = results.filter((r) => r.error)
  let msg = `${results.length} 个文件解析完成，共发现 ${related} 个相关事项`
  if (errors.length) msg += `；${errors.length} 个失败（${errors[0].error}）`
  return msg
}
