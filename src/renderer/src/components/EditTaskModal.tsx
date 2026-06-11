import { useState } from 'react'
import type { ItemType, Priority, TaskRecord } from '@shared/types'
import Modal from './Modal'
import { TYPE_LABELS } from '../labels'

interface Props {
  task: TaskRecord
  heading: string
  confirmLabel: string
  onSave: (patch: Partial<TaskRecord>) => void
  onClose: () => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none'

export default function EditTaskModal({
  task,
  heading,
  confirmLabel,
  onSave,
  onClose
}: Props): React.JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [itemType, setItemType] = useState<ItemType>(task.itemType)
  const [startTime, setStartTime] = useState(task.startTime ?? '')
  const [dueTime, setDueTime] = useState(task.dueTime ?? '')
  const [location, setLocation] = useState(task.location ?? '')
  const [priority, setPriority] = useState<Priority>(task.priority)

  const save = (): void => {
    if (!title.trim()) return
    onSave({
      title: title.trim(),
      itemType,
      startTime: startTime || null,
      dueTime: dueTime || null,
      location: location.trim() || null,
      priority
    })
  }

  return (
    <Modal panelClass="w-[480px] rounded-xl bg-white p-5 shadow-2xl" onClose={onClose}>
      {(close) => (
        <>
        <h3 className="mb-4 text-base font-semibold">{heading}</h3>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">任务标题</span>
            <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">类型</span>
              <select
                className={input}
                value={itemType}
                onChange={(e) => setItemType(e.target.value as ItemType)}
              >
                {Object.entries(TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">优先级</span>
              <select
                className={input}
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                <option value="high">高</option>
                <option value="medium">中</option>
                <option value="low">低</option>
                <option value="unknown">未定</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">开始时间</span>
              <input
                type="datetime-local"
                className={input}
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">截止时间</span>
              <input
                type="datetime-local"
                className={input}
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">地点</span>
            <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-4 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
            onClick={close}
          >
            取消
          </button>
          <button
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-700"
            onClick={save}
          >
            {confirmLabel}
          </button>
        </div>
        </>
      )}
    </Modal>
  )
}
