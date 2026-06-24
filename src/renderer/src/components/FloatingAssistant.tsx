import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskRecord } from '@shared/types'
import { api } from '../api'
import AssistantChat from './AssistantChat'
import agentAvatar from '../assets/agent-avatar.png'

interface Props {
  tasks: TaskRecord[]
  showToast: (msg: string) => void
  hotkeyLabel: string
  userName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 右下角悬浮助手：常驻圆按钮 + 点开的对话面板（Notion 式），覆盖在任意页面之上 */
export default function FloatingAssistant({
  tasks,
  showToast,
  hotkeyLabel,
  userName,
  open,
  onOpenChange
}: Props): React.JSX.Element {
  // 关闭时先播放淡出动画再卸载：open 决定播 in/out，mounted 决定何时真正卸载
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (!mounted) return
    const t = window.setTimeout(() => setMounted(false), 160)
    return () => window.clearTimeout(t)
  }, [open, mounted])

  // 闲置自动收起（秒数可在设置改；0=不收起）。面板内任何点击/输入/移动都重置计时
  const [autoCloseSec, setAutoCloseSec] = useState(60)
  useEffect(() => {
    const load = (): void => void api.getSettings().then((s) => setAutoCloseSec(s.assistantAutoCloseSec))
    load()
    return api.on('eshell:settings-updated', load)
  }, [])
  const idleTimer = useRef<number | undefined>(undefined)
  const bumpIdle = useCallback(() => {
    window.clearTimeout(idleTimer.current)
    if (open && autoCloseSec > 0)
      idleTimer.current = window.setTimeout(() => onOpenChange(false), autoCloseSec * 1000)
  }, [open, autoCloseSec, onOpenChange])
  useEffect(() => {
    bumpIdle()
    return () => window.clearTimeout(idleTimer.current)
  }, [bumpIdle])

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30" onClick={() => onOpenChange(false)} aria-hidden />
      )}
      {mounted && (
        <div
          onMouseMove={bumpIdle}
          onMouseDown={bumpIdle}
          onKeyDown={bumpIdle}
          className={`${open ? 'animate-modal-in' : 'animate-modal-out'} fixed right-5 bottom-24 z-40 flex h-[min(600px,72vh)] w-[400px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-2xl`}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <img src={agentAvatar} alt="纸壳助手" className="size-6" />
              <span className="text-sm font-semibold">纸壳助手</span>
            </div>
            <button
              onClick={() => onOpenChange(false)}
              aria-label="收起助手"
              className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AssistantChat
              tasks={tasks}
              showToast={showToast}
              hotkeyLabel={hotkeyLabel}
              userName={userName}
            />
          </div>
        </div>
      )}
    </>
  )
}
