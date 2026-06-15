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
    <Modal
      panelClass="modal w-[480px] shadow-[0_24px_70px_-10px_#0f172a55]"
      onClose={onClose}
    >
      {(close) => (
        <>
          <div className="modal-head">
            <h3>{heading}</h3>
            <button className="x" onClick={close}>✕</button>
          </div>

          <div className="modal-body">
            <div className="field" style={{ marginBottom: 14 }}>
              <span>任务标题</span>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div className="grid2" style={{ marginBottom: 14 }}>
              <div className="field">
                <span>类型</span>
                <select value={itemType} onChange={(e) => setItemType(e.target.value as ItemType)}>
                  {Object.entries(TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span>优先级</span>
                <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                  <option value="unknown">未定</option>
                </select>
              </div>
            </div>

            <div className="grid2" style={{ marginBottom: 14 }}>
              <div className="field">
                <span>开始时间</span>
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
              <div className="field">
                <span>截止时间</span>
                <input
                  type="datetime-local"
                  value={dueTime}
                  onChange={(e) => setDueTime(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <span>地点</span>
              <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          </div>

          <div className="modal-foot">
            <button className="btn ghost sm" onClick={close}>取消</button>
            <button className="btn primary sm" onClick={save}>{confirmLabel}</button>
          </div>
        </>
      )}
    </Modal>
  )
}
