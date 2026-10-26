import { primaryModifier } from '../platform'
import { useState } from 'react'
import type { ItemType } from '@shared/types'
import type { ParsedItem } from '@shared/parsing'
import { api } from '../api'
import { useExitParticipant } from '../exit-lifecycle'
import Modal from './Modal'
import { Segmented } from './ui'

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

const TYPE_OPTIONS: { value: ItemType; label: string }[] = [
  { value: 'meeting', label: '会议 / 活动' },
  { value: 'deadline', label: '截止任务' },
  { value: 'reminder', label: '提醒' },
  { value: 'other', label: '其他' }
]

/**
 * 日程页悬浮加号：手动创建日程。两种方式——
 * 随手记（自然语言一句话，云端解析出标题/时间，可一次写多条）/ 表单（精确填字段，零模型调用）。
 * 用户亲手输入 → 归属本人、直接入库，不再走确认流。
 */
export default function QuickAddTask({ onAdded }: { onAdded: (msg: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'nl' | 'form'>('nl')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<ItemType>('meeting')
  const [start, setStart] = useState('')
  const [due, setDue] = useState('')
  const [location, setLocation] = useState('')

  const reset = (): void => {
    setText('')
    setTitle('')
    setStart('')
    setDue('')
    setLocation('')
    setErr('')
    setBusy(false)
  }

  useExitParticipant({ id: 'quick-add-task', label: '新建日程中有尚未提交的输入', canSave: false,
    isDirty: () => open && !!(text.trim() || title.trim() || start || due || location.trim()),
    prepare: async () => { reset() } })

  const submitNl = async (close: () => void): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await api.quickAddTask(text.trim())
      if (!r.added) {
        setErr('没解析出可创建的日程——试试补上时间，或换个说法')
        setBusy(false)
        return
      }
      onAdded(r.added === 1 ? `已创建「${r.titles[0]}」` : `已创建 ${r.added} 条日程`)
      reset()
      close()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const submitForm = async (close: () => void): Promise<void> => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    setErr('')
    const item: ParsedItem = {
      title: t,
      item_type: type,
      belongs_to_user: 'yes',
      belonging_reason: '用户手动创建',
      user_role: 'owner',
      start_time: start || null,
      due_time: due || null,
      location: location.trim() || null,
      priority: 'unknown',
      confidence: 1,
      suggested_action: 'add',
      evidence: [],
      notes: [],
      duplicate_of: null
    }
    try {
      await api.assistantAdd({ sourceText: '手动创建', item, force: true })
      onAdded(`已创建「${t}」`)
      reset()
      close()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      {/* 悬浮加号：页面右下角（悬浮助手无常驻按钮，底角是空的；助手面板 z-40 打开时盖过此钮无碍） */}
      <button
        className="fixed right-6 bottom-6 z-20 flex size-12 items-center justify-center rounded-full bg-brand text-white shadow-lg transition-transform hover:scale-105 hover:bg-brand-dark"
        title="新建日程"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>

      {open && (
        <Modal panelClass="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl" onClose={() => setOpen(false)}>
          {(close) => (
            <>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold">新建日程</h3>
                <div className="flex items-center gap-3">
                  <Segmented
                    value={mode}
                    onChange={setMode}
                    options={[
                      ['nl', '随手记'],
                      ['form', '表单']
                    ]}
                  />
                  <button className="text-slate-400 hover:text-slate-600" onClick={close}>
                    ✕
                  </button>
                </div>
              </div>

              {mode === 'nl' ? (
                <div className="flex flex-col gap-3">
                  <textarea
                    autoFocus
                    className={`${input} min-h-[96px] resize-y leading-6`}
                    placeholder={'一句话描述，我来解析时间和标题，例如：\n明天下午3点和张老师在会议室A开组会\n周五前把开题报告发给导师'}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitNl(close)
                    }}
                  />
                  {err && <p className="text-xs text-red-500">{err}</p>}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">可一次写多条，{primaryModifier}+回车 提交</span>
                    <button
                      className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
                      disabled={busy || !text.trim()}
                      onClick={() => void submitNl(close)}
                    >
                      {busy ? '解析中…' : '创建'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-slate-500">标题 *</span>
                    <input autoFocus className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-slate-500">类型</span>
                      <select className={input} value={type} onChange={(e) => setType(e.target.value as ItemType)}>
                        {TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-slate-500">地点</span>
                      <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-slate-500">开始时间</span>
                      <input type="datetime-local" className={input} value={start} onChange={(e) => setStart(e.target.value)} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-slate-500">截止时间</span>
                      <input type="datetime-local" className={input} value={due} onChange={(e) => setDue(e.target.value)} />
                    </label>
                  </div>
                  {err && <p className="text-xs text-red-500">{err}</p>}
                  <div className="flex justify-end">
                    <button
                      className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
                      disabled={busy || !title.trim()}
                      onClick={() => void submitForm(close)}
                    >
                      创建
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  )
}
