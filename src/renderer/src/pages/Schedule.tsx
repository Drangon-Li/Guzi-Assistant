import { useCallback, useEffect, useState } from 'react'
import type { DetectionRecord, TaskRecord, TaskStatus } from '@shared/types'
import { api } from '../api'
import { dayKey, fmtTime, PRIORITY_LABELS, STATUS_LABELS, todayKey, TYPE_LABELS } from '../labels'
import EditTaskModal from '../components/EditTaskModal'
import SourceModal from '../components/SourceModal'
import TaskDetailModal from '../components/TaskDetailModal'
import Timeline, { type TimelineMode } from './Timeline'
import QuickAddTask from '../components/QuickAddTask'
import { Segmented } from '../components/ui'

interface Props {
  tasks: TaskRecord[]
  hotkeyLabel: string
  onOpenAssistant: () => void
}

type Tab = 'today' | 'next3' | 'week' | 'all'
type View = 'list' | 'timeline'

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
  const [view, setView] = useState<View>('list')
  const [tab, setTab] = useState<Tab>('today')
  const [tlMode, setTlMode] = useState<TimelineMode>('day')
  const [editing, setEditing] = useState<TaskRecord | null>(null)
  const [detail, setDetail] = useState<TaskRecord | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 3500)
  }

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
  } else if (tab === 'week' || tab === 'next3') {
    if (overdue.length) sections.push({ title: '已延期', list: overdue })
    const days = tab === 'next3' ? 3 : 7
    const base = new Date()
    for (let i = 0; i < days; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
      const pad = (n: number): string => String(n).padStart(2, '0')
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const list = active.filter((t) => dayKey(timeOf(t)) === key && t.status !== 'overdue')
      if (!list.length && i > 0) continue
      const label =
        i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : `${WEEKDAY[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`
      sections.push({ title: label, list, empty: i === 0 ? '今天没有安排的任务' : undefined })
    }
    if (unscheduled.length) sections.push({ title: '未排期', list: unscheduled })
  } else {
    sections.push({ title: '全部未完成', list: active, empty: '没有未完成的任务' })
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">日程</h1>
          {/* 视图切换：列表（操作）/ 时间轴（浏览）。原独立「时间轴」页并入此处 */}
          <Segmented
            value={view}
            onChange={setView}
            options={[
              ['list', '列表'],
              ['timeline', '时间轴']
            ]}
          />
        </div>
        {/* 右侧筛选随视图切换：列表=时间范围，时间轴=分组粒度 */}
        {view === 'list' ? (
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              ['today', '今日'],
              ['next3', '近三天'],
              ['week', '本周'],
              ['all', '全部']
            ]}
          />
        ) : (
          <Segmented
            value={tlMode}
            onChange={setTlMode}
            options={[
              ['day', '天'],
              ['week', '周'],
              ['month', '月']
            ]}
          />
        )}
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

        <PendingDetections />

        {tasks.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
            <div className="text-base font-semibold text-slate-800">还没有任何日程</div>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              谷子助手会自动留意你的通知、消息和截图，从中帮你拎出该办的事，发现后在右下角的助手里提给你确认。
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              也可以手动添加：复制内容后按 <b>{hotkeyLabel}</b>，或点右下角的助手直接问我 / 把文件拖进窗口。
            </p>
            <button
              onClick={onOpenAssistant}
              className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm text-white hover:bg-brand-dark"
            >
              打开助手
            </button>
          </div>
        )}

        {tasks.length > 0 && view === 'timeline' && <Timeline tasks={tasks} mode={tlMode} />}

        {tasks.length > 0 &&
          view === 'list' &&
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

        {view === 'list' && ignored.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 select-none">
              已忽略（{ignored.length}）
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              {ignored.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface px-3 py-2"
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

        {view === 'list' && done.length > 0 && (
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

      {/* 悬浮加号：随手记（自然语言解析）/ 表单 两种方式手动建日程 */}
      <QuickAddTask onAdded={flash} />
      {note && (
        <div
          key={note}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm text-white shadow-lg"
        >
          {note}
        </div>
      )}
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
      className={`flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-sm ${
        leaving ? 'animate-task-done' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={toggle}
        className="size-4 shrink-0 accent-brand"
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

/**
 * 待确认检测兜底区：没弹卡（完全被动模式）或弹卡未作决定的检测在这里回看处理。
 * （原「记忆 → 历史」的检测列表已随记忆页拆除，这里是唯一兜底入口。）
 */
function PendingDetections(): React.JSX.Element | null {
  const [dets, setDets] = useState<DetectionRecord[]>([])
  const [open, setOpen] = useState(false)

  const load = useCallback((): void => void api.listDetections().then(setDets), [])
  useEffect(() => {
    load()
    // 检测无专属广播：蹭任务更新事件刷新（同意检测会触发它），展开时也会重新拉
    return api.on('eshell:tasks-updated', load)
  }, [load])

  const fresh = dets.filter((d) => d.status === 'new')
  if (!fresh.length) return null

  const accept = async (id: string): Promise<void> => {
    await api.acceptDetection(id)
    load()
  }
  const dismiss = async (id: string): Promise<void> => {
    await api.dismissDetection(id)
    load()
  }
  // 积压兜底：历史弱信号可能攒几百条，逐条忽略不现实
  const dismissAll = async (): Promise<void> => {
    await Promise.all(fresh.map((d) => api.dismissDetection(d.id)))
    load()
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface shadow-sm">
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => {
          if (!open) load()
          setOpen(!open)
        }}
      >
        <span className="text-sm text-slate-600">
          有 <b className="text-brand">{fresh.length}</b> 条检测待确认
          <span className="ml-2 text-xs text-slate-400">检测到但还没确认的日程；已过时的会自动转入忽略</span>
        </span>
        <span className={`shrink-0 text-xs text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>
          ›
        </span>
      </button>
      {open && (
        <ul className="border-t border-slate-100 px-4 py-1">
          {fresh.length > 3 && (
            <li className="flex justify-end py-1.5">
              <button
                className="text-[11px] text-slate-400 hover:text-red-500"
                onClick={() => void dismissAll()}
              >
                全部忽略（{fresh.length}）
              </button>
            </li>
          )}
          {fresh.slice(0, 10).map((d) => (
            <li key={d.id} className="flex items-center gap-3 border-b border-slate-100 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{d.title}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {d.timeIso ? fmtTime(d.timeIso) : '未识别到时间'} · 检测于{' '}
                  {d.createdAt.slice(5, 16).replace('T', ' ')}
                </div>
              </div>
              <button
                className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                onClick={() => void dismiss(d.id)}
              >
                忽略
              </button>
              <button
                className="shrink-0 rounded-lg bg-brand px-3 py-1 text-[11px] text-white hover:bg-brand-dark"
                onClick={() => void accept(d.id)}
              >
                同意
              </button>
            </li>
          ))}
          {fresh.length > 10 && (
            <li className="py-2 text-center text-[11px] text-slate-400">
              还有 {fresh.length - 10} 条，处理后自动显示
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
