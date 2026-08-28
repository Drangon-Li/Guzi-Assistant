// 作息页：一天的时间块 + 模板库。
//
// 「日程」管有截止时间的任务，「作息」管有起止时间的安排——这条边界写在页头，
// 因为两个页面概念相近，不说清用户会分不清该往哪儿记。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkRecord } from '@shared/types'
import { dayKey } from '@shared/work-report'
import {
  conflictsWith,
  coverageOf,
  durationLabel,
  labelToMinutes,
  minutesToLabel,
  plannedMinutes,
  templateForDate,
  weekdaysLabel,
  type TemplateBlock,
  type TimeBlock,
  type TimeTemplate
} from '@shared/timeblock'
import { api } from '../../api'
import Modal from '../../components/Modal'
import { DayNav, Section } from '../../components/ui'

/** 每分钟的像素高度。1.0 时一天 1440px，滚动一屏多一点，块的相对长短一眼能比出来。 */
const PPM = 1
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

interface DayPayload {
  blocks: TimeBlock[]
  templates: TimeTemplate[]
  templateBlocks: TemplateBlock[]
}

interface DraftState {
  id: string | null
  startMin: number
  endMin: number
  title: string
  tag: string
}

/** 工作记录的实际起止 → 分钟区间，只留落在这一天的部分。 */
function actualSpans(records: readonly WorkRecord[], day: string): { startMin: number; endMin: number }[] {
  const spans: { startMin: number; endMin: number }[] = []
  for (const r of records) {
    if (!r.startAt || !r.endAt) continue
    const s = new Date(r.startAt)
    const e = new Date(r.endAt)
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) continue
    if (dayKey(s) !== day) continue
    const startMin = s.getHours() * 60 + s.getMinutes()
    const endMin = dayKey(e) === day ? e.getHours() * 60 + e.getMinutes() : 1440
    if (endMin > startMin) spans.push({ startMin, endMin })
  }
  return spans
}

export default function TimeblockPage(): React.JSX.Element {
  const [day, setDay] = useState(() => dayKey(new Date()))
  const [blocks, setBlocks] = useState<TimeBlock[]>([])
  const [templates, setTemplates] = useState<TimeTemplate[]>([])
  const [templateBlocks, setTemplateBlocks] = useState<TemplateBlock[]>([])
  const [actual, setActual] = useState<{ startMin: number; endMin: number }[]>([])
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateDays, setTemplateDays] = useState<number[]>([])
  const [note, setNote] = useState('')
  const laneRef = useRef<HTMLDivElement>(null)

  const flash = useCallback((msg: string) => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2400)
  }, [])

  const load = useCallback(async () => {
    const res = await api.plugin<DayPayload>('timeblock', 'day', day)
    setBlocks(res.blocks)
    setTemplates(res.templates)
    setTemplateBlocks(res.templateBlocks)
  }, [day])

  useEffect(() => {
    void load()
  }, [load])

  // 实际活动来自屏幕感知的工作记录；没开这个功能就只画计划，不提示什么
  useEffect(() => {
    void api.listWorkRecords(day).then((rs) => setActual(actualSpans(rs, day)))
  }, [day])

  const suggested = useMemo(() => templateForDate(templates, day), [templates, day])
  const appliedTemplateIds = useMemo(
    () => new Set(blocks.map((b) => b.templateId).filter(Boolean)),
    [blocks]
  )
  const planned = useMemo(() => plannedMinutes(blocks), [blocks])

  const openDraft = (startMin: number): void =>
    setDraft({ id: null, startMin, endMin: Math.min(1440, startMin + 60), title: '', tag: '' })

  const editDraft = (b: TimeBlock): void =>
    setDraft({ id: b.id, startMin: b.startMin, endMin: b.endMin, title: b.title, tag: b.tag ?? '' })

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    if (!draft.title.trim()) return flash('写一句要做什么')
    if (draft.startMin >= draft.endMin) return flash('结束时间要晚于开始时间')
    if (draft.id) {
      await api.plugin('timeblock', 'update', draft.id, {
        startMin: draft.startMin,
        endMin: draft.endMin,
        title: draft.title.trim(),
        tag: draft.tag.trim() || null
      })
    } else {
      await api.plugin('timeblock', 'create', {
        date: day,
        startMin: draft.startMin,
        endMin: draft.endMin,
        title: draft.title.trim(),
        tag: draft.tag.trim() || null,
        taskId: null,
        done: false,
        templateId: null
      })
    }
    setDraft(null)
    await load()
  }

  const removeBlock = async (id: string): Promise<void> => {
    await api.plugin('timeblock', 'delete', id)
    setDraft(null)
    await load()
  }

  const toggleDone = async (b: TimeBlock): Promise<void> => {
    await api.plugin('timeblock', 'update', b.id, { done: !b.done })
    await load()
  }

  const applyTpl = async (id: string): Promise<void> => {
    const created = (await api.plugin('timeblock', 'template-apply', id, day)) as TimeBlock[]
    await load()
    flash(created.length ? `套用了 ${created.length} 个时间块` : '这个模板还没有内容')
  }

  const saveAsTemplate = async (): Promise<void> => {
    if (!templateName.trim()) return flash('给模板起个名字')
    if (!blocks.length) return flash('这一天还没有时间块')
    await api.plugin(
      'timeblock',
      'template-save',
      templateName.trim(),
      templateDays,
      blocks.map((b) => ({ startMin: b.startMin, endMin: b.endMin, title: b.title, tag: b.tag }))
    )
    setSavingTemplate(false)
    setTemplateName('')
    setTemplateDays([])
    await load()
    flash('模板已保存')
  }

  const deleteTpl = async (id: string): Promise<void> => {
    await api.plugin('timeblock', 'template-delete', id)
    await load()
  }

  // 点空白处新建：把点击位置换算成最近的整刻钟，避免出现 09:07 这种起点
  const onLaneClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== laneRef.current) return
    const rect = laneRef.current.getBoundingClientRect()
    const min = Math.round((e.clientY - rect.top) / PPM / 15) * 15
    openDraft(Math.max(0, Math.min(1440 - 15, min)))
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <header className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">作息</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              这里排的是「几点到几点做什么」。有截止时间的任务在「日程」页，两边不重复。
            </p>
          </div>
          <DayNav day={day} onChange={setDay} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>
            已排 <span className="font-medium text-slate-600">{durationLabel(0, planned)}</span>
          </span>
          <span>共 {blocks.length} 个时间块</span>
          {actual.length > 0 && <span className="text-brand">右侧细条是屏幕感知记到的实际活动</span>}
        </div>
      </header>

      {suggested && !appliedTemplateIds.has(suggested.id) && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-brand/30 bg-brand-soft px-4 py-2.5 text-sm">
          <span>
            今天是周{WEEKDAYS[new Date(`${day}T12:00:00`).getDay()]}，要套用模板「{suggested.name}」吗？
          </span>
          <button
            onClick={() => void applyTpl(suggested.id)}
            className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-white"
          >
            套用
          </button>
        </div>
      )}

      <div className="flex gap-5">
        <div className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
          <div className="flex">
            <div className="w-12 shrink-0">
              {Array.from({ length: 25 }, (_, h) => (
                <div
                  key={h}
                  className="relative text-[11px] text-slate-300 tabular-nums"
                  style={{ height: 60 * PPM }}
                >
                  <span className="absolute -top-1.5">{String(h).padStart(2, '0')}:00</span>
                </div>
              ))}
            </div>

            <div
              ref={laneRef}
              onClick={onLaneClick}
              className="relative flex-1 cursor-copy rounded-md bg-slate-50/60"
              style={{ height: 1440 * PPM }}
              title="点击空白处新建时间块"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="pointer-events-none absolute inset-x-0 border-t border-slate-100"
                  style={{ top: h * 60 * PPM }}
                />
              ))}

              {blocks.map((b) => {
                const coverage = actual.length ? coverageOf(b, actual) : null
                const clash = conflictsWith(blocks, b, b.id).length > 0
                return (
                  <button
                    key={b.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      editDraft(b)
                    }}
                    style={{
                      top: b.startMin * PPM,
                      height: Math.max(18, (b.endMin - b.startMin) * PPM - 2)
                    }}
                    className={`absolute inset-x-1 overflow-hidden rounded-md border px-2 py-1 text-left text-xs transition-colors ${
                      b.done
                        ? 'border-slate-200 bg-slate-100 text-slate-400 line-through'
                        : 'border-brand/40 bg-brand-soft text-slate-700 hover:border-brand'
                    } ${clash ? 'ring-1 ring-amber-300' : ''}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        role="checkbox"
                        aria-checked={b.done}
                        aria-label={b.done ? '标记为未完成' : '标记为完成'}
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          void toggleDone(b)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            void toggleDone(b)
                          }
                        }}
                        className={`size-3 shrink-0 cursor-pointer rounded-sm border ${
                          b.done ? 'border-slate-300 bg-slate-300' : 'border-brand/50'
                        }`}
                      />
                      <span className="truncate font-medium">{b.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-400 tabular-nums">
                      <span>
                        {minutesToLabel(b.startMin)}–{minutesToLabel(b.endMin)}
                      </span>
                      {b.tag && <span className="rounded bg-white/70 px-1">{b.tag}</span>}
                      {coverage !== null && coverage > 0.05 && (
                        <span title="这段计划被实际活动覆盖的比例">实际 {Math.round(coverage * 100)}%</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="relative ml-1 w-2 shrink-0 rounded bg-slate-50" style={{ height: 1440 * PPM }}>
              {actual.map((s, i) => (
                <div
                  key={i}
                  className="absolute inset-x-0 rounded-sm bg-emerald-300/70"
                  style={{ top: s.startMin * PPM, height: Math.max(2, (s.endMin - s.startMin) * PPM) }}
                />
              ))}
            </div>
          </div>
        </div>

        <aside className="w-64 shrink-0 space-y-4">
          <Section
            title="模板"
            desc="把满意的一天存下来，之后一键套用"
            actions={
              <button
                onClick={() => setSavingTemplate(true)}
                className="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-brand hover:text-brand"
              >
                存为模板
              </button>
            }
          >
            {templates.length === 0 ? (
              <p className="text-xs text-slate-400">还没有模板。先排好一天，再点右上角存下来。</p>
            ) : (
              <ul className="space-y-2">
                {templates.map((t) => (
                  <li key={t.id} className="rounded-lg border border-slate-100 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{t.name}</span>
                      <div className="flex shrink-0 gap-1.5 text-xs">
                        <button
                          onClick={() => void applyTpl(t.id)}
                          className="text-brand hover:underline"
                        >
                          套用
                        </button>
                        <button
                          onClick={() => void deleteTpl(t.id)}
                          className="text-slate-300 hover:text-red-500"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      {templateBlocks.filter((b) => b.templateId === t.id).length} 个块 ·{' '}
                      {weekdaysLabel(t.weekdays)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>

      {draft && (
        <Modal
          panelClass="w-[22rem] rounded-xl bg-surface p-5 shadow-xl"
          onClose={() => setDraft(null)}
        >
          {(close) => (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">{draft.id ? '编辑时间块' : '新建时间块'}</h2>
              <input
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveDraft()
                }}
                placeholder="要做什么，比如「看论文」"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <div className="flex items-center gap-2">
                <TimeInput
                  value={draft.startMin}
                  onChange={(v) => setDraft({ ...draft, startMin: v })}
                  label="开始"
                />
                <span className="pt-4 text-slate-300">–</span>
                <TimeInput
                  value={draft.endMin}
                  onChange={(v) => setDraft({ ...draft, endMin: v })}
                  label="结束"
                />
              </div>
              <input
                value={draft.tag}
                onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
                placeholder="标签（可留空）"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <div className="flex items-center justify-between pt-1">
                {draft.id ? (
                  <button
                    onClick={() => void removeBlock(draft.id as string)}
                    className="text-xs text-slate-400 hover:text-red-500"
                  >
                    删除
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <button onClick={close} className="rounded-lg px-3 py-1.5 text-sm text-slate-500">
                    取消
                  </button>
                  <button
                    onClick={() => void saveDraft()}
                    className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white"
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          )}
        </Modal>
      )}

      {savingTemplate && (
        <Modal
          panelClass="w-[22rem] rounded-xl bg-surface p-5 shadow-xl"
          onClose={() => setSavingTemplate(false)}
        >
          {(close) => (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">把这一天存为模板</h2>
              <p className="text-xs text-slate-400">当前 {blocks.length} 个时间块会被记进模板。</p>
              <input
                autoFocus
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="模板名，比如「工作日」"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <div>
                <div className="mb-1.5 text-xs text-slate-400">每周哪几天自动提示套用（可不选）</div>
                <div className="flex gap-1">
                  {WEEKDAYS.map((label, i) => (
                    <button
                      key={i}
                      onClick={() =>
                        setTemplateDays((ds) =>
                          ds.includes(i) ? ds.filter((d) => d !== i) : [...ds, i]
                        )
                      }
                      className={`size-7 rounded-md border text-xs transition-colors ${
                        templateDays.includes(i)
                          ? 'border-brand bg-brand-soft text-brand'
                          : 'border-slate-200 text-slate-400'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={close} className="rounded-lg px-3 py-1.5 text-sm text-slate-500">
                  取消
                </button>
                <button
                  onClick={() => void saveAsTemplate()}
                  className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white"
                >
                  保存
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {note && (
        <div
          key={note}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2 text-sm text-white shadow-lg"
        >
          {note}
        </div>
      )}
    </div>
  )
}

/** HH:MM 输入框：只在解析成功时回写，输入中途不打断用户。 */
function TimeInput({
  value,
  onChange,
  label
}: {
  value: number
  onChange: (v: number) => void
  label: string
}): React.JSX.Element {
  const [text, setText] = useState(() => minutesToLabel(value))
  useEffect(() => setText(minutesToLabel(value)), [value])
  return (
    <label className="flex-1">
      <span className="mb-1 block text-xs text-slate-400">{label}</span>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const min = labelToMinutes(e.target.value)
          if (min !== null) onChange(min)
        }}
        onBlur={() => setText(minutesToLabel(value))}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums outline-none focus:border-brand"
      />
    </label>
  )
}
