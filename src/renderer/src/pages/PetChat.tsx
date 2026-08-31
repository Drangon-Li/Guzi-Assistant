import { useCallback, useEffect, useRef, useState } from 'react'
import type { Profile, TaskRecord } from '@shared/types'
import { api } from '../api'
import { formatHotkey } from '../labels'
import AssistantChat from '../components/AssistantChat'

/** 桌宠旁的气泡对话框（独立无边框窗口 #/petchat）：复用 AssistantChat，能聊天/建任务/问任务。 */
export default function PetChat(): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [hotkeyLabel, setHotkeyLabel] = useState('⌥ C')
  const [clearNonce, setClearNonce] = useState(0)
  // 桌宠拖入文件 → 主进程推来「总结+找日程」请求，注入对话
  const [injected, setInjected] = useState<{ content: string; display: string; nonce: number } | null>(null)
  const dropNonce = useRef(0)

  const refresh = useCallback(() => {
    void api.listTasks().then(setTasks)
  }, [])

  useEffect(() => {
    return api.on('guzi-assistant:pet-chat-drop', (p) => {
      const d = p as { display?: string; content?: string }
      if (!d || typeof d.content !== 'string' || typeof d.display !== 'string') return
      setInjected({ content: d.content, display: d.display, nonce: ++dropNonce.current })
    })
  }, [])

  useEffect(() => {
    void api.getProfile().then(setProfile)
    refresh()
    void api.getSettings().then((s) => setHotkeyLabel(formatHotkey(s.hotkey)))
    const off = api.on('guzi-assistant:tasks-updated', refresh)
    return off
  }, [refresh])

  // Esc 收起对话框，⌘K 清屏
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void api.petChatHide()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setClearNonce((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const noop = useCallback(() => {}, [])

  return (
    <div className="flex h-full w-full flex-col p-2">
      <div className="animate-modal-in flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-2xl">
        <header className="flex shrink-0 items-center justify-between px-2 pt-1.5">
          <button
            onClick={() => setClearNonce((n) => n + 1)}
            title="清屏（⌘K）"
            className="rounded-lg px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            清屏
          </button>
          <button
            onClick={() => void api.petChatHide()}
            aria-label="收起"
            className="rounded-lg px-2 py-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1">
          {profile ? (
            <AssistantChat
              tasks={tasks}
              showToast={noop}
              hotkeyLabel={hotkeyLabel}
              userName={profile.name}
              injected={injected}
              clearNonce={clearNonce}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="size-5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
