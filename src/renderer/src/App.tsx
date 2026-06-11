import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParseSummary, Profile, TaskRecord } from '@shared/types'
import { api } from './api'
import { summaryToast } from './labels'
import Onboarding from './pages/Onboarding'
import Inbox from './pages/Inbox'
import Schedule from './pages/Schedule'
import Settings from './pages/Settings'
import PreviewCard from './pages/PreviewCard'

type Page = 'inbox' | 'schedule' | 'settings'

const NAV: { key: Page; label: string }[] = [
  { key: 'inbox', label: '待确认收件箱' },
  { key: 'schedule', label: '日程' },
  { key: 'settings', label: '设置' }
]

export default function App(): React.JSX.Element {
  if (window.location.hash.includes('/preview')) return <PreviewCard />
  return <MainApp />
}

function MainApp(): React.JSX.Element | null {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [page, setPage] = useState<Page>('inbox')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
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
    const offTasks = api.on('al1:tasks-updated', refresh)
    const offNav = api.on('al1:navigate', (route) => {
      if (route === 'inbox' || route === 'schedule' || route === 'settings') setPage(route)
    })
    return () => {
      offTasks()
      offNav()
    }
  }, [refresh])

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.al1.pathForFile(f))
    if (!paths.length) return
    showToast(`正在解析 ${paths.length} 个文件…`)
    const results = await api.captureFiles(paths)
    showToast(filesToast(results))
  }

  if (profile === undefined) return null
  if (profile === null) return <Onboarding onDone={setProfile} />

  const pendingCount = tasks.filter((t) => t.status === 'pending').length

  return (
    <div
      className="flex h-full bg-slate-100 text-slate-800"
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
      <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="px-5 pt-6 pb-4">
          <div className="text-xl font-bold tracking-tight">al1</div>
          <div className="mt-0.5 text-xs text-slate-400">个人事项捕获助手</div>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                page === item.key ? 'bg-indigo-50 font-medium text-indigo-700' : 'hover:bg-slate-100'
              }`}
            >
              <span>{item.label}</span>
              {item.key === 'inbox' && pendingCount > 0 && (
                <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-5 pb-5 text-[11px] leading-5 text-slate-400">
          复制内容后按 ⌥C（Option + C），快速提交剪切板。
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {page === 'inbox' && <Inbox tasks={tasks} showToast={showToast} />}
        {page === 'schedule' && <Schedule tasks={tasks} />}
        {page === 'settings' && <Settings onProfileChange={setProfile} />}
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-indigo-600/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-indigo-400 bg-white px-8 py-6 text-indigo-600 shadow-lg">
            松开以提交文件（图片 / PDF / docx / txt）
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">
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
