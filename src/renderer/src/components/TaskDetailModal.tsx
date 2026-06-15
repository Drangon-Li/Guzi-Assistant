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
  'w-full rounded-[7px] border border-[color:var(--line-2)] bg-[var(--card)] px-[11px] py-[7px] text-[13px] text-[color:var(--t1)] outline-none transition-colors focus:border-[color:var(--line-3)]'

const EDIT_STATUSES: TaskStatus[] = ['not_started', 'scheduled', 'in_progress', 'done']

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

  // #15：改判「不是我的事」→ 归属置 no（触发主进程个性化学习）+ 移出列表（ignored）
  const markNotMine = async (): Promise<void> => {
    await api.updateTask(current.id, { belongsToUser: 'no', status: 'ignored' })
    setCurrent({ ...current, belongsToUser: 'no', status: 'ignored' })
  }

  const due = current.dueTime ?? current.startTime

  return (
    <Modal panelClass="modal w-[560px] flex flex-col max-h-[84vh]" onClose={onClose}>
      {(close) => (
        <>
          {/* 头部 */}
          <div className="modal-head">
            <span className="tag">{TYPE_LABELS[editing ? itemType : current.itemType]}</span>
            {editing ? (
              <input className={`${input} flex-1 text-base font-semibold`} value={title} onChange={(e) => setTitle(e.target.value)} />
            ) : (
              <h3>{current.title}</h3>
            )}
            {!editing && <span className="pill">{STATUS_LABELS[current.status]}</span>}
            <button className="x" onClick={close}>✕</button>
          </div>

          {/* 正文 */}
          <div className="modal-body min-h-0 flex-1">
            {editing ? (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs" style={{ color: 'var(--t3)' }}>类型</span>
                  <select className={input} value={itemType} onChange={(e) => setItemType(e.target.value as ItemType)}>
                    {Object.entries(TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs" style={{ color: 'var(--t3)' }}>状态</span>
                  <select className={input} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                    {EDIT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs" style={{ color: 'var(--t3)' }}>开始时间</span>
                  <input type="datetime-local" className={input} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs" style={{ color: 'var(--t3)' }}>截止时间</span>
                  <input type="datetime-local" className={input} value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs" style={{ color: 'var(--t3)' }}>地点</span>
                  <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs" style={{ color: 'var(--t3)' }}>优先级</span>
                  <select className={input} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                    <option value="unknown">未定</option>
                  </select>
                </label>
                <label className="col-span-2 flex flex-col gap-1">
                  <span className="text-xs" style={{ color: 'var(--t3)' }}>注意事项（每行一条）</span>
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
                <div className="detail-grid">
                  {current.startTime && (
                    <div className="kv">
                      <div className="k">开始时间</div>
                      <div className="v">{fmtTime(current.startTime)}</div>
                    </div>
                  )}
                  {current.dueTime && (
                    <div className="kv">
                      <div className="k">截止时间</div>
                      <div className="v"><span className="is-danger">{fmtTime(current.dueTime)}</span></div>
                    </div>
                  )}
                  {due && current.status !== 'done' && (
                    <div className="kv">
                      <div className="k">倒计时</div>
                      <div className="v">
                        <span className={current.status === 'overdue' ? 'is-danger' : ''}>
                          {countdownLabel(due)}
                        </span>
                      </div>
                    </div>
                  )}
                  {current.location && (
                    <div className="kv">
                      <div className="k">地点</div>
                      <div className="v">{current.location}</div>
                    </div>
                  )}
                  <div className="kv">
                    <div className="k">优先级</div>
                    <div className="v">{PRIORITY_LABELS[current.priority]}</div>
                  </div>
                  <div className="kv">
                    <div className="k">我的角色</div>
                    <div className="v">{ROLE_LABELS[current.userRole]}</div>
                  </div>
                  <div className="kv">
                    <div className="k">归属置信度</div>
                    <div className="v"><ConfidenceBadge value={current.confidence} /></div>
                  </div>
                </div>

                <div
                  className={`note-box${
                    current.belongsToUser === 'yes'
                      ? ' yes'
                      : current.belongsToUser === 'no'
                        ? ''
                        : ' maybe'
                  }`}
                >
                  {current.belongsToUser === 'yes'
                    ? '判断属于你：'
                    : current.belongsToUser === 'no'
                      ? '已标记：不是你的事。'
                      : '不确定是否属于你：'}
                  {current.belongingReason || '无说明'}
                  {current.belongsToUser !== 'no' && (
                    <div style={{ marginTop: '8px' }}>
                      <button
                        onClick={() => void markNotMine()}
                        className="btn outline sm"
                      >
                        不是我的事
                      </button>
                    </div>
                  )}
                </div>

                {current.duplicateOf && (
                  <div className="note-box maybe" style={{ marginTop: '8px' }}>
                    疑似重复：可能与已有任务「{current.duplicateOf}」是同一件事
                  </div>
                )}

                {current.notes.length > 0 && (
                  <>
                    <div className="subhead">注意事项</div>
                    <ol className="notes-ol">
                      {current.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ol>
                  </>
                )}

                {current.evidence.length > 0 && (
                  <>
                    <div className="subhead">原文证据</div>
                    {current.evidence.map((ev, i) => (
                      <div key={i} className="evidence" style={i > 0 ? { marginTop: '8px' } : undefined}>
                        {ev}
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* 底部操作 */}
          <div className="modal-foot">
            {editing ? (
              <>
                <button
                  className="btn ghost sm"
                  onClick={() => setEditing(false)}
                >
                  取消
                </button>
                <button
                  className="btn primary sm"
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
                    className="btn ghost sm"
                    onClick={onShowSource}
                  >
                    查看来源原文
                  </button>
                )}
                <button
                  className="btn outline sm"
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
                  className="btn outline sm"
                  onClick={startEdit}
                >
                  编辑
                </button>
                <button
                  className="btn primary sm"
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
