import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParseSummary, Profile, TaskRecord } from '@shared/types'
import { api } from './api'
import { formatHotkey, summaryToast } from './labels'
import Onboarding from './pages/Onboarding'
import Assistant from './pages/Assistant'
import Timeline from './pages/Timeline'
import Schedule from './pages/Schedule'
import Settings from './pages/Settings'
import PreviewCard from './pages/PreviewCard'

type Page = 'assistant' | 'timeline' | 'schedule' | 'settings'

const NAV: { key: Page; label: string }[] = [
  { key: 'assistant', label: '助手' },
  { key: 'timeline', label: '时间轴' },
  { key: 'schedule', label: '日程' },
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
      else if (route === 'timeline' || route === 'schedule' || route === 'settings') setPage(route)
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

  if (profile === undefined)
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="size-6 animate-spin rounded-full border-2 border-slate-700 border-t-transparent" />
      </div>
    )
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
      <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200/60 bg-[#fafafa]">
        <div className="px-5 pt-10 pb-4 titlebar-pad">
          <div className="text-base font-semibold tracking-tight">EShell</div>
          <div className="mt-0.5 text-xs text-slate-400">个人事项捕获助手</div>
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
              {item.key === 'assistant' && pendingCount > 0 && (
                <span className="rounded-full bg-ink px-1.5 py-0.5 text-[10px] leading-none text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
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
