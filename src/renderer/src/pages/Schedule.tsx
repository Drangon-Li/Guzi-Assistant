import { useState } from 'react'
import type { TaskRecord, TaskStatus } from '@shared/types'
import { api } from '../api'
import { dayKey, fmtTime, PRIORITY_LABELS, STATUS_LABELS, todayKey, TYPE_LABELS } from '../labels'
import EditTaskModal from '../components/EditTaskModal'
import SourceModal from '../components/SourceModal'
import TaskDetailModal from '../components/TaskDetailModal'

interface Props {
  tasks: TaskRecord[]
  hotkeyLabel: string
  onOpenAssistant: () => void
}

type Tab = 'today' | 'week' | 'all'

const ACTIVE_STATUSES: TaskStatus[] = ['not_started', 'scheduled', 'in_progress', 'overdue']
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function timeOf(t: TaskRecord): string | null {
  return t.dueTime ?? t.startTime
}

function byTime(a: TaskRecord, b: TaskRecord): number {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (!ta && !tb) return 0
  if (!ta) return 1
  if (!tb) return -1
  return ta.localeCompare(tb)
}

function nowLocal(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function Schedule({ tasks, hotkeyLabel, onOpenAssistant }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('today')
  const [editing, setEditing] = useState<TaskRecord | null>(null)
  const [detail, setDetail] = useState<TaskRecord | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)

  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).sort(byTime)
  const pending = tasks.filter((t) => t.status === 'pending')
  const done = tasks.filter((t) => t.status === 'done')
  const ignored = tasks.filter((t) => t.status === 'ignored')
  const overdue = active.filter((t) => t.status === 'overdue')
  const unscheduled = active.filter((t) => !timeOf(t) && t.status !== 'overdue')

  const sections: { title: string; list: TaskRecord[]; empty?: string }[] = []
  if (tab === 'today') {
    const today = todayKey()
    if (overdue.length) sections.push({ title: '已延期', list: overdue })
    sections.push({
      title: '今日',
      list: active.filter((t) => dayKey(timeOf(t)) === today && t.status !== 'overdue'),
      empty: '今天没有安排的任务'
    })
    if (unscheduled.length) sections.push({ title: '未排期', list: unscheduled })
  } else if (tab === 'week') {
    if (overdue.length) sections.push({ title: '已延期', list: overdue })
    const base = new Date()
    for (let i = 0; i < 7; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
      const pad = (n: number): string => String(n).padStart(2, '0')
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const list = active.filter((t) => dayKey(timeOf(t)) === key && t.status !== 'overdue')
      if (!list.length && i > 0) continue
      const label =
        i === 0 ? '今天' : i === 1 ? '明天' : `${WEEKDAY[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`
      sections.push({ title: label, list, empty: i === 0 ? '今天没有安排的任务' : undefined })
    }
    if (unscheduled.length) sections.push({ title: '未排期', list: unscheduled })
  } else {
    sections.push({ title: '全部未完成', list: active, empty: '没有未完成的任务' })
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">日程</h1>
        <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
          {(
            [
              ['today', '今日'],
              ['week', '本周'],
              ['all', '全部']
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1 ${
                tab === key
                  ? 'bg-white text-slate-900 font-medium shadow-sm'
                  : 'text-slate-400 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-6 pb-10">
        {pending.length > 0 && (
          <button
            onClick={onOpenAssistant}
            className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left transition-colors hover:bg-amber-100/70"
          >
            <span className="text-sm text-amber-800">
              助手发现了 <b>{pending.length}</b> 个待确认事项
            </span>
            <span className="shrink-0 text-xs font-medium text-amber-700">去确认 →</span>
          </button>
        )}

        {tasks.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-base font-semibold text-slate-800">还没有任何日程</div>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              纸壳助手会自动留意你的通知、消息和截图，从中帮你拎出该办的事，发现后在右下角的助手里提给你确认。
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              也可以手动添加：复制内容后按 <b>{hotkeyLabel}</b>，或点右下角的助手直接问我 / 把文件拖进窗口。
            </p>
            <button
              onClick={onOpenAssistant}
              className="mt-4 rounded-lg bg-ink px-4 py-2 text-sm text-white hover:bg-black"
            >
              打开助手
            </button>
          </div>
        )}

        {tasks.length > 0 &&
          sections.map((sec) => (
          <section key={sec.title}>
            <h2 className="mb-2 text-xs font-medium text-slate-400">{sec.title}</h2>
            <div className="flex flex-col gap-2">
              {sec.list.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onOpen={() => setDetail(t)}
                  onEdit={() => setEditing(t)}
                  onShowSource={() => t.sourceId && setSourceId(t.sourceId)}
                />
              ))}
              {!sec.list.length && sec.empty && (
                <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-slate-400">
                  {sec.empty}
                </div>
              )}
            </div>
          </section>
        ))}

        {ignored.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 select-none">
              已忽略（{ignored.length}）
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              {ignored.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{t.title}</span>
                  {t.feedback === 'not_mine' && (
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">
                      不是我的
                    </span>
                  )}
                  <button
                    className="shrink-0 rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => void api.updateTask(t.id, { status: 'pending', feedback: null })}
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}

        {done.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 select-none">
              已完成（{done.length}）
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {done.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onOpen={() => setDetail(t)}
                  onEdit={() => setEditing(t)}
                  onShowSource={() => t.sourceId && setSourceId(t.sourceId)}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      {editing && (
        <EditTaskModal
          task={editing}
          heading="编辑任务"
          confirmLabel="保存"
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            // 延期任务改到未来时间后恢复为已安排
            if (editing.status === 'overdue' && patch.dueTime && patch.dueTime > nowLocal()) {
              patch.status = 'scheduled'
            }
            void api.updateTask(editing.id, patch)
            setEditing(null)
          }}
        />
      )}
      {detail && (
        <TaskDetailModal
          task={detail}
          onClose={() => setDetail(null)}
          onShowSource={() => detail.sourceId && setSourceId(detail.sourceId)}
        />
      )}
      {sourceId && <SourceModal sourceId={sourceId} onClose={() => setSourceId(null)} />}
    </div>
  )
}

function TaskRow({
  task,
  onOpen,
  onEdit,
  onShowSource
}: {
  task: TaskRecord
  onOpen: () => void
  onEdit: () => void
  onShowSource: () => void
}): React.JSX.Element {
  const isDone = task.status === 'done'
  const isOverdue = task.status === 'overdue'
  const [leaving, setLeaving] = useState(false)
  const completing = !isDone

  // 勾选后先播完成动画（保持勾选/划线），动画结束再真正改状态，避免任务瞬间消失
  const toggle = (): void => {
    if (leaving) return
    setLeaving(true)
    const next: TaskStatus = isDone
      ? task.dueTime || task.startTime
        ? 'scheduled'
        : 'not_started'
      : 'done'
    window.setTimeout(() => void api.updateTask(task.id, { status: next }), 340)
  }
  const checked = leaving ? completing : isDone
  const strike = isDone || (leaving && completing)

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm ${
        leaving ? 'animate-task-done' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={toggle}
        className="size-4 shrink-0 accent-slate-800"
      />
      <div className="min-w-0 flex-1">
        <button
          onClick={onOpen}
          className={`block w-full truncate text-left text-sm hover:text-slate-900 ${
            strike ? 'text-slate-400 line-through' : ''
          }`}
        >
          {task.title}
        </button>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-400">
          <span>{TYPE_LABELS[task.itemType]}</span>
          {task.notes.length > 0 && <span>{task.notes.length} 条注意事项</span>}
          {task.startTime && <span>开始 {fmtTime(task.startTime)}</span>}
          {task.dueTime && (
            <span className={isOverdue ? 'font-medium text-red-500' : ''}>
              截止 {fmtTime(task.dueTime)}
            </span>
          )}
          {task.location && <span>{task.location}</span>}
          {task.priority !== 'unknown' && <span>优先级 {PRIORITY_LABELS[task.priority]}</span>}
        </div>
      </div>
      {isOverdue ? (
        <span className="shrink-0 rounded-full border border-[#c0584e]/30 px-2 py-0.5 text-[11px] text-[#c0584e]">
          已延期
        </span>
      ) : (
        !isDone && (
          <select
            value={task.status}
            onChange={(e) => void api.updateTask(task.id, { status: e.target.value as TaskStatus })}
            className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 focus:outline-none"
          >
            {(['not_started', 'scheduled', 'in_progress'] as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        )
      )}
      <button
        className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-slate-700 hover:bg-slate-50"
        onClick={onEdit}
      >
        编辑
      </button>
      {task.sourceId && (
        <button
          className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-slate-700 hover:bg-slate-50"
          onClick={onShowSource}
        >
          来源
        </button>
      )}
    </div>
  )
}
