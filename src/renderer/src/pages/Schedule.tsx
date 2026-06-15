import { useState } from 'react'
import type { TaskRecord, TaskStatus } from '@shared/types'
import { api } from '../api'
import { dayKey, fmtTime, PRIORITY_LABELS, STATUS_LABELS, todayKey, TYPE_LABELS } from '../labels'
import EditTaskModal from '../components/EditTaskModal'
import SourceModal from '../components/SourceModal'
import TaskDetailModal from '../components/TaskDetailModal'

interface Props {
  tasks: TaskRecord[]
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

export default function Schedule({ tasks }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('today')
  const [editing, setEditing] = useState<TaskRecord | null>(null)
  const [detail, setDetail] = useState<TaskRecord | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)

  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).sort(byTime)
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
    <div className="page animate-page">
      <div className="page-head">
        <div className="page-title">日程</div>
        <div className="seg">
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
              className={tab === key ? 'on' : ''}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {sections.map((sec) => (
          <div key={sec.title}>
            <h2 className="sec-head">{sec.title}</h2>
            <div className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
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
                <div className="empty">{sec.empty}</div>
              )}
            </div>
          </div>
        ))}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {done.length > 0 && (
            <details>
              <summary className="fold" style={{ cursor: 'pointer', listStyle: 'none' }}>
                ▸ 已完成（{done.length}）
              </summary>
              <div className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
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
          {ignored.length > 0 && (
            <details>
              <summary className="fold" style={{ cursor: 'pointer', listStyle: 'none' }}>
                ▸ 已忽略（{ignored.length}）
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
                {ignored.map((t) => (
                  <div key={t.id} className="task-row">
                    <div className="body">
                      <div className="tt">{t.title}</div>
                      {t.feedback === 'not_mine' && (
                        <div className="sub">
                          <span>不是我的</span>
                        </div>
                      )}
                    </div>
                    <button
                      className="linkbtn"
                      onClick={() => void api.updateTask(t.id, { status: 'pending', feedback: null })}
                    >
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
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

  return (
    <div className="task-row">
      <div
        className={isDone ? 'checkbox on' : 'checkbox'}
        onClick={() =>
          void api.updateTask(task.id, {
            status: isDone ? (task.dueTime || task.startTime ? 'scheduled' : 'not_started') : 'done'
          })
        }
        style={{ cursor: 'pointer' }}
      >
        {isDone && (
          <svg viewBox="0 0 12 12" fill="none">
            <polyline points="2,6 5,9 10,3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <div className="body">
        <div className={isDone ? 'tt done' : 'tt'} onClick={onOpen} style={{ cursor: 'pointer' }}>
          {task.title}
        </div>
        <div className="sub">
          <span>{TYPE_LABELS[task.itemType]}</span>
          {task.notes.length > 0 && <span>{task.notes.length} 条注意事项</span>}
          {task.startTime && <span>开始 {fmtTime(task.startTime)}</span>}
          {task.dueTime && (
            <span className={isOverdue ? 'is-danger' : ''}>
              截止 {fmtTime(task.dueTime)}
            </span>
          )}
          {task.location && <span>{task.location}</span>}
          {task.priority !== 'unknown' && <span>优先级 {PRIORITY_LABELS[task.priority]}</span>}
        </div>
      </div>
      {isOverdue ? (
        <span className="pill danger">已延期</span>
      ) : (
        !isDone && (
          <select
            className="mini-select"
            value={task.status}
            onChange={(e) => void api.updateTask(task.id, { status: e.target.value as TaskStatus })}
          >
            {(['not_started', 'scheduled', 'in_progress'] as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        )
      )}
      <button className="linkbtn" onClick={onEdit}>编辑</button>
      {task.sourceId && (
        <button className="linkbtn" onClick={onShowSource}>来源</button>
      )}
    </div>
  )
}
