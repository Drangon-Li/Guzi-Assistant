import { useState } from 'react'
import { clearExitSaveError, trackExitSave, useExitParticipant } from '../exit-lifecycle'
import type { ItemType, Priority, TaskRecord } from '@shared/types'
import Modal from './Modal'
import { REMIND_OPTIONS, remindFromInput, remindToInput, TYPE_LABELS } from '../labels'

interface Props {
  task: TaskRecord
  heading: string
  confirmLabel: string
  onSave: (patch: Partial<TaskRecord>) => void | Promise<void>
  onClose: () => void
  /** 传入即显示「删除任务」（两步确认后触发）；不传则不显示 */
  onDelete?: () => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/5'

export default function EditTaskModal({
  task,
  heading,
  confirmLabel,
  onSave,
  onClose,
  onDelete
}: Props): React.JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [itemType, setItemType] = useState<ItemType>(task.itemType)
  const [startTime, setStartTime] = useState(task.startTime ?? '')
  const [dueTime, setDueTime] = useState(task.dueTime ?? '')
  const [location, setLocation] = useState(task.location ?? '')
  const [priority, setPriority] = useState<Priority>(task.priority)
  const [remind, setRemind] = useState(remindToInput(task.remindOffsetMin))
  const [tags, setTags] = useState<string[]>(task.tags)
  const [tagDraft, setTagDraft] = useState('')
  const [checklistText, setChecklistText] = useState(task.checklist.map((c) => c.text).join('\n'))
  const [confirmDelete, setConfirmDelete] = useState(false)

  const addTag = (): void => {
    const t = tagDraft.trim().replace(/^#/, '')
    if (t && !tags.includes(t) && tags.length < 8) setTags([...tags, t])
    setTagDraft('')
  }

  const save = async (): Promise<void> => {
    if (!title.trim()) throw new Error('任务标题不能为空')
    await trackExitSave(Promise.resolve(onSave({
      title: title.trim(),
      itemType,
      startTime: startTime || null,
      dueTime: dueTime || null,
      location: location.trim() || null,
      priority,
      tags: tagDraft.trim() && !tags.includes(tagDraft.trim().replace(/^#/, '')) && tags.length < 8
        ? [...tags, tagDraft.trim().replace(/^#/, '')] : tags,
      // 按行重建清单；同名条目保留原勾选状态
      checklist: checklistText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((text) => ({ text, done: task.checklist.find((c) => c.text === text)?.done ?? false })),
      remindOffsetMin: remindFromInput(remind)
    })), `edit-task:${task.id}`)
  }

  const dirty = title !== task.title || itemType !== task.itemType || startTime !== (task.startTime ?? '') ||
      dueTime !== (task.dueTime ?? '') || location !== (task.location ?? '') || priority !== task.priority ||
      remind !== remindToInput(task.remindOffsetMin) || JSON.stringify(tags) !== JSON.stringify(task.tags) ||
      checklistText !== task.checklist.map((item) => item.text).join('\n') || !!tagDraft.trim()
  useExitParticipant({ id: `edit-task:${task.id}`, label: '日程任务编辑尚未保存',
    isDirty: () => dirty,
    alwaysPrepare: true,
    prepare: async (decision) => { if (decision === 'save' && dirty) await save(); else clearExitSaveError(`edit-task:${task.id}`) } })

  return (
    <Modal panelClass="w-[480px] rounded-xl bg-surface p-5 shadow-2xl" onClose={onClose}>
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
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">地点</span>
              <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">提醒</span>
              <select className={input} value={remind} onChange={(e) => setRemind(e.target.value)}>
                {REMIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">检查清单（每行一条，详情页可逐项勾选）</span>
            <textarea
              className={`${input} min-h-16 resize-y leading-6`}
              value={checklistText}
              onChange={(e) => setChecklistText(e.target.value)}
              placeholder="如：订会议室&#10;准备幻灯片"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-slate-500">标签</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <span key={t} className="flex items-center gap-1 rounded-md bg-brand-soft px-2 py-0.5 text-xs text-brand">
                  #{t}
                  <button
                    className="text-brand/60 hover:text-brand"
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                className="min-w-24 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:border-slate-400 focus:outline-none"
                placeholder="回车添加标签，如 课程"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    addTag()
                  }
                }}
                onBlur={addTag}
              />
            </div>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-2">
          {onDelete &&
            (confirmDelete ? (
              <button
                className="rounded-lg bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600"
                onClick={onDelete}
              >
                确认删除
              </button>
            ) : (
              <button
                className="rounded-lg px-3 py-1.5 text-sm text-red-400 hover:bg-red-50 hover:text-red-600"
                onClick={() => setConfirmDelete(true)}
              >
                删除任务
              </button>
            ))}
          <div className="flex-1" />
          <button
            className="rounded-lg px-4 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
            onClick={close}
          >
            取消
          </button>
          <button
            className="rounded-lg bg-brand px-4 py-1.5 text-sm text-white hover:bg-brand-dark"
            onClick={() => void save().catch((error) => window.alert(String(error)))}
          >
            {confirmLabel}
          </button>
        </div>
        </>
      )}
    </Modal>
  )
}
