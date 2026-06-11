import { useState } from 'react'
import type { TaskRecord } from '@shared/types'
import { api } from '../api'
import { summaryToast } from '../labels'
import TaskCard from '../components/TaskCard'
import EditTaskModal from '../components/EditTaskModal'
import SourceModal from '../components/SourceModal'

interface Props {
  tasks: TaskRecord[]
  showToast: (msg: string) => void
}

function joinStatus(t: { startTime?: string | null; dueTime?: string | null }): 'scheduled' | 'not_started' {
  return t.dueTime || t.startTime ? 'scheduled' : 'not_started'
}

export default function Inbox({ tasks, showToast }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<TaskRecord | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)

  const pending = tasks.filter((t) => t.status === 'pending')

  const submitText = async (): Promise<void> => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    showToast('解析中…')
    const summary = await api.captureText(value)
    setBusy(false)
    if (!summary.error) setText('')
    showToast(summaryToast(summary))
  }

  const screenshot = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const summary = await api.captureScreenshot()
    setBusy(false)
    showToast(summary ? summaryToast(summary) : '已取消截图')
  }

  const join = (t: TaskRecord): void => {
    void api.updateTask(t.id, { status: joinStatus(t) })
  }

  const joinMany = async (list: TaskRecord[]): Promise<void> => {
    const withTime = list.filter((t) => t.dueTime || t.startTime).map((t) => t.id)
    const withoutTime = list.filter((t) => !t.dueTime && !t.startTime).map((t) => t.id)
    if (withTime.length) await api.bulkTasks(withTime, 'scheduled')
    if (withoutTime.length) await api.bulkTasks(withoutTime, 'not_started')
    showToast(`已加入 ${list.length} 个任务`)
  }

  const highConfidence = pending.filter((t) => t.confidence >= 0.85 && t.belongsToUser === 'yes')

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="text-lg font-semibold">待确认收件箱</h1>
      <p className="mt-1 text-xs text-slate-400">
        AI 发现的事项先在这里等你确认，不会直接进入日程。
      </p>

      <div className="mt-5 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitText()
          }}
          placeholder="粘贴通知、聊天记录或邮件内容…（⌘+Enter 提交，也可以把文件拖进窗口）"
          rows={3}
          className="w-full resize-none rounded-lg border-0 bg-transparent px-1 py-1 text-sm focus:outline-none"
        />
        <div className="flex items-center gap-2 border-t border-slate-100 pt-2">
          <button
            onClick={() => void submitText()}
            disabled={busy || !text.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? '解析中…' : '提交解析'}
          </button>
          <button
            onClick={() => void screenshot()}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            截图捕获
          </button>
          <button
            onClick={() => void api.captureClipboard()}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            读取剪切板
          </button>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="mt-6 flex items-center gap-2">
          <span className="text-xs text-slate-400">{pending.length} 个待确认</span>
          <div className="ml-auto flex gap-2">
            {highConfidence.length > 0 && highConfidence.length < pending.length && (
              <button
                className="rounded-lg border border-indigo-200 px-3 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
                onClick={() => void joinMany(highConfidence)}
              >
                只加入高置信度（{highConfidence.length}）
              </button>
            )}
            <button
              className="rounded-lg border border-indigo-200 px-3 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
              onClick={() => void joinMany(pending)}
            >
              全部加入
            </button>
            <button
              className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50"
              onClick={() => void api.bulkTasks(pending.map((t) => t.id), 'ignored')}
            >
              全部忽略
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-3 pb-10">
        {pending.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onJoin={() => join(t)}
            onEdit={() => setEditing(t)}
            onIgnore={() => void api.updateTask(t.id, { status: 'ignored' })}
            onNotMine={() => void api.updateTask(t.id, { status: 'ignored', feedback: 'not_mine' })}
            onShowSource={() => t.sourceId && setSourceId(t.sourceId)}
          />
        ))}
        {!pending.length && (
          <div className="mt-10 text-center text-sm leading-7 text-slate-400">
            现在没有待确认的事项。
            <br />
            看到通知先复制，再按住 <kbd className="rounded bg-slate-200 px-1.5 py-0.5 text-xs">Space</kbd>{' '}
            + <kbd className="rounded bg-slate-200 px-1.5 py-0.5 text-xs">C</kbd> 丢给 al1。
          </div>
        )}
      </div>

      {editing && (
        <EditTaskModal
          task={editing}
          heading="修改后加入"
          confirmLabel="保存并加入"
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            void api.updateTask(editing.id, { ...patch, status: joinStatus(patch) })
            setEditing(null)
          }}
        />
      )}
      {sourceId && <SourceModal sourceId={sourceId} onClose={() => setSourceId(null)} />}
    </div>
  )
}
