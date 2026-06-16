import type { TaskRecord } from '@shared/types'
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
  const pendingCount = tasks.filter((t) => t.status === 'pending').length

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30" onClick={() => onOpenChange(false)} aria-hidden />
      )}
      {open && (
        <div className="animate-modal-in fixed right-5 bottom-24 z-40 flex h-[min(600px,72vh)] w-[400px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
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

      <button
        onClick={() => onOpenChange(!open)}
        title={open ? '收起助手' : '打开助手'}
        className="fixed right-5 bottom-5 z-40 flex size-14 items-center justify-center rounded-full border border-slate-200 bg-white shadow-lg transition-shadow hover:shadow-xl"
      >
        <img src={agentAvatar} alt="纸壳助手" className="size-9" />
        {pendingCount > 0 && !open && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-5 items-center justify-center rounded-full bg-ink px-1.5 py-0.5 text-[10px] leading-none text-white">
            {pendingCount}
          </span>
        )}
      </button>
    </>
  )
}
