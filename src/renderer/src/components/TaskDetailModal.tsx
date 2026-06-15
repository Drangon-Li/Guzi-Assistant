import { useState } from 'react'
import type { ItemType, Priority, TaskRecord, TaskStatus } from '@shared/types'
import { api } from '../api'
import Modal from './Modal'
import ConfidenceBadge from './ConfidenceBadge'
import {
  countdownLabel,
  fmtTime,
  PRIORITY_LABELS,
  ROLE_LABELS,
  STATUS_LABELS,
  TYPE_LABELS
} from '../labels'

interface Props {
  task: TaskRecord
  onShowSource: () => void
  onClose: () => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/5'

const EDIT_STATUSES: TaskStatus[] = ['not_started', 'scheduled', 'in_progress', 'done']

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  )
}

export default function TaskDetailModal({ task, onShowSource, onClose }: Props): React.JSX.Element {
  const [current, setCurrent] = useState<TaskRecord>(task)
  const [editing, setEditing] = useState(false)

  const [title, setTitle] = useState(task.title)
  const [itemType, setItemType] = useState<ItemType>(task.itemType)
  const [startTime, setStartTime] = useState(task.startTime ?? '')
  const [dueTime, setDueTime] = useState(task.dueTime ?? '')
  const [location, setLocation] = useState(task.location ?? '')
  const [priority, setPriority] = useState<Priority>(task.priority)
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [notesText, setNotesText] = useState(task.notes.join('\n'))

  const startEdit = (): void => {
    setTitle(current.title)
    setItemType(current.itemType)
    setStartTime(current.startTime ?? '')
    setDueTime(current.dueTime ?? '')
    setLocation(current.location ?? '')
    setPriority(current.priority)
    setStatus(EDIT_STATUSES.includes(current.status) ? current.status : 'scheduled')
    setNotesText(current.notes.join('\n'))
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    if (!title.trim()) return
    const patch: Partial<TaskRecord> = {
      title: title.trim(),
      itemType,
      startTime: startTime || null,
      dueTime: dueTime || null,
      location: location.trim() || null,
      priority,
      status,
      notes: notesText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    await api.updateTask(current.id, patch)
    setCurrent({ ...current, ...patch } as TaskRecord)
    setEditing(false)
  }

  const due = current.dueTime ?? current.startTime

  return (
    <Modal panelClass="flex max-h-[84vh] w-[580px] flex-col rounded-xl bg-white shadow-2xl" onClose={onClose}>
      {(close) => (
        <>
          <div className="flex items-start gap-2 border-b border-slate-100 p-5 pb-4">
            <span className="mt-1 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
              {TYPE_LABELS[editing ? itemType : current.itemType]}
            </span>
            {editing ? (
              <input className={`${input} text-base font-semibold`} value={title} onChange={(e) => setTitle(e.target.value)} />
            ) : (
              <h3 className="min-w-0 flex-1 text-base leading-6 font-semibold">{current.title}</h3>
            )}
            {!editing && (
              <span className="mt-1 shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                {STATUS_LABELS[current.status]}
              </span>
            )}
            <button className="mt-0.5 px-1 text-slate-400 hover:text-slate-600" onClick={close}>
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {editing ? (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">类型</span>
                  <select className={input} value={itemType} onChange={(e) => setItemType(e.target.value as ItemType)}>
                    {Object.entries(TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">状态</span>
                  <select className={input} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                    {EDIT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">开始时间</span>
                  <input type="datetime-local" className={input} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">截止时间</span>
                  <input type="datetime-local" className={input} value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">地点</span>
                  <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">优先级</span>
                  <select className={input} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                    <option value="unknown">未定</option>
                  </select>
                </label>
                <label className="col-span-2 flex flex-col gap-1">
                  <span className="text-xs text-slate-400">注意事项（每行一条）</span>
                  <textarea
                    className={`${input} min-h-32 resize-y leading-6`}
                    value={notesText}
                    onChange={(e) => setNotesText(e.target.value)}
                    placeholder="如：携带一卡通和身份证&#10;提前 10 分钟到场签到"
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  {current.startTime && <Field label="开始时间">{fmtTime(current.startTime)}</Field>}
                  {current.dueTime && (
                    <Field label="截止时间">
                      <span className="text-red-500">{fmtTime(current.dueTime)}</span>
                    </Field>
                  )}
                  {due && current.status !== 'done' && (
                    <Field label="倒计时">
                      <span className={current.status === 'overdue' ? 'text-[#c0584e]' : 'text-slate-700'}>
                        {countdownLabel(due)}
                      </span>
                    </Field>
                  )}
                  {current.location && <Field label="地点">{current.location}</Field>}
                  <Field label="优先级">{PRIORITY_LABELS[current.priority]}</Field>
                  <Field label="我的角色">{ROLE_LABELS[current.userRole]}</Field>
                  <Field label="归属置信度">
                    <ConfidenceBadge value={current.confidence} />
                  </Field>
                </div>

                <div
                  className={`mt-4 rounded-lg px-3 py-2 text-xs leading-5 ${
                    current.belongsToUser === 'yes'
                      ? 'bg-emerald-50 text-emerald-800'
                      : 'bg-amber-50 text-amber-800'
                  }`}
                >
                  {current.belongsToUser === 'yes' ? '判断属于你：' : '不确定是否属于你：'}
                  {current.belongingReason || '无说明'}
                </div>

                {current.duplicateOf && (
                  <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                    疑似重复：可能与已有任务「{current.duplicateOf}」是同一件事
                  </div>
                )}

                {current.notes.length > 0 && (
                  <div className="mt-4">
                    <h4 className="mb-2 text-xs font-medium text-slate-400">注意事项</h4>
                    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-6 text-slate-700">
                      {current.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ol>
                  </div>
                )}

                {current.evidence.length > 0 && (
                  <div className="mt-4">
                    <h4 className="mb-2 text-xs font-medium text-slate-400">原文证据</h4>
                    <div className="flex flex-col gap-1.5">
                      {current.evidence.map((ev, i) => (
                        <blockquote key={i} className="border-l-2 border-slate-300 pl-2 text-xs leading-5 text-slate-600">
                          {ev}
                        </blockquote>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-4">
            {editing ? (
              <>
                <button
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                  onClick={() => setEditing(false)}
                >
                  取消
                </button>
                <button
                  className="rounded-lg bg-ink px-4 py-1.5 text-xs text-white hover:bg-black disabled:opacity-40"
                  disabled={!title.trim()}
                  onClick={() => void save()}
                >
                  保存修改
                </button>
              </>
            ) : (
              <>
                {current.sourceId && (
                  <button
                    className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                    onClick={onShowSource}
                  >
                    查看来源原文
                  </button>
                )}
                <button
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  disabled={!current.startTime && !current.dueTime}
                  title={
                    current.startTime || current.dueTime
                      ? '导出 .ics 并用系统日历打开'
                      : '该任务没有时间，无法加入日历'
                  }
                  onClick={() => void api.exportTaskIcs(current)}
                >
                  加入日历
                </button>
                <button
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                  onClick={startEdit}
                >
                  编辑
                </button>
                <button
                  className="rounded-lg bg-ink px-4 py-1.5 text-xs text-white hover:bg-black"
                  onClick={close}
                >
                  关闭
                </button>
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
