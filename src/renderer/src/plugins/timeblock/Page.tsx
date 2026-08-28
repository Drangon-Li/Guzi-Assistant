// 作息页：一天的时间块 + 模板 + 计划对照实际。
//
// 「日程」管有截止时间的任务，「作息」管有起止时间的安排——这条边界写在页头，
// 因为两个页面概念相近，不说清用户会分不清该往哪儿记。
//
// 布局取舍：整天 24 小时铺满会拉出两三屏，绝大多数时间都在看空白。
// 默认只渲染「有内容的时段」（按已有块的范围 + 当前时间推算，至少 8 小时），
// 想看全天再切。密度三档，紧凑档常见的一天基本一屏装得下。
//
// 交互取舍：块可以直接拖动改时间、拖下沿改时长；空白处按住往下拖是**框选建块**
// （Sunsama / 日历应用的通用手势），比每次点一下再改数字快得多。拖动一律吸附 5 分钟，
// 避免出现 09:07 这种起点。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TaskRecord, WorkRecord } from '@shared/types'
import { isFinishedEvent } from '@shared/task-filters'
import { dayKey } from '@shared/work-report'
import {
  conflictsWith,
  coverageOf,
  durationLabel,
  labelToMinutes,
  minutesToLabel,
  plannedMinutes,
  focusSessions,
  templateForDate,
  viewWindow,
  weekdaysLabel,
  type FocusSession,
  type TemplateBlock,
  type TimeBlock,
  type TimeTemplate
} from '@shared/timeblock'
import { api } from '../../api'
import Modal from '../../components/Modal'
import { DayNav, Segmented } from '../../components/ui'
import type { PluginPageProps } from '../types'

const SNAP = 5 // 拖动吸附粒度（分钟）
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const DURATION_PRESETS = [25, 30, 45, 60, 90, 120]
const ACTIVE_STATUS = new Set(['not_started', 'scheduled', 'in_progress', 'overdue'])

type Density = 'compact' | 'normal' | 'roomy'
const PPM: Record<Density, number> = { compact: 0.7, normal: 1.05, roomy: 1.6 }

type ViewMode = 'auto' | 'full'

const PREF_KEY = 'timeblock.view'
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(`${PREF_KEY}.${key}`)
    return allowed.includes(v as T) ? (v as T) : fallback
  } catch {
    return fallback
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(`${PREF_KEY}.${key}`, value)
  } catch {
    /* 隐私模式下写不了，不影响使用 */
  }
}

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
  taskId: string | null
}

type DragMode = 'move' | 'resize'
interface DragState {
  id: string
  mode: DragMode
  originY: number
  startMin: number
  endMin: number
  preview: { startMin: number; endMin: number }
}

/** 空白处框选：从 anchor 拉到 cursor，松手建块。 */
interface SelectState {
  anchorMin: number
  cursorMin: number
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

const snap = (min: number): number => Math.round(min / SNAP) * SNAP
const clampMin = (m: number): number => Math.max(0, Math.min(1440, m))

function shiftDay(date: string, delta: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + delta)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function TimeblockPage({ enabledPlugins }: PluginPageProps): React.JSX.Element {
  const pomodoroEnabled = enabledPlugins.includes('pomodoro')

  const [day, setDay] = useState(() => dayKey(new Date()))
  const [blocks, setBlocks] = useState<TimeBlock[]>([])
  const [templates, setTemplates] = useState<TimeTemplate[]>([])
  const [templateBlocks, setTemplateBlocks] = useState<TemplateBlock[]>([])
  const [actual, setActual] = useState<{ startMin: number; endMin: number }[]>([])
  const [sessions, setSessions] = useState<FocusSession[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateDays, setTemplateDays] = useState<number[]>([])
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [note, setNote] = useState('')
  const [drag, setDrag] = useState<DragState | null>(null)
  const [select, setSelect] = useState<SelectState | null>(null)
  const [nowMin, setNowMin] = useState(() => {
    const d = new Date()
    return d.getHours() * 60 + d.getMinutes()
  })
  const [view, setViewRaw] = useState<ViewMode>(() => readPref('mode', ['auto', 'full'], 'auto'))
  const [density, setDensityRaw] = useState<Density>(() =>
    readPref('density', ['compact', 'normal', 'roomy'], 'normal')
  )
  const laneRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef('')

  const setView = (v: ViewMode): void => {
    setViewRaw(v)
    writePref('mode', v)
  }
  const setDensity = (d: Density): void => {
    setDensityRaw(d)
    writePref('density', d)
  }

  const ppm = PPM[density]
  const isToday = day === dayKey(new Date())

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

  useEffect(() => {
    void api.listTasks().then(setTasks)
  }, [])

  // 「专注」回写了这一轮的时长就刷新。作息不认识专注插件，只认识一个事件名；
  // 没装专注插件的话这个事件永远不会来，这里也不需要判断。
  useEffect(() => {
    return api.on('guzi-assistant:plugin-event', (payload) => {
      if ((payload as { event?: string }).event === 'pomodoro:round-completed') void load()
    })
  }, [load])

  // 实际活动来自屏幕感知的工作记录；没开这个功能就只画计划，不提示什么。
  // 原始区间留着算「计划被覆盖了多少」，右侧只展示归并后的长段——
  // 10 分钟一块的碎点铺满一列既看不懂也没用。
  useEffect(() => {
    void api.listWorkRecords(day).then((rs) => {
      setActual(actualSpans(rs, day))
      setSessions(focusSessions(rs, day))
    })
  }, [day])

  // 当前时间线每分钟走一格就够
  useEffect(() => {
    const t = window.setInterval(() => {
      const d = new Date()
      setNowMin(d.getHours() * 60 + d.getMinutes())
    }, 60_000)
    return () => window.clearInterval(t)
  }, [])

  /**
   * 视图窗口：把空白的凌晨和深夜折掉。取「已有块 + 当前时间」的包络，
   * 上下各留半小时，再对齐到整点；不足 8 小时就以 08:00 为中心补足，
   * 免得只有一个块时窗口窄得像条缝。
   */
  const [viewStart, viewEnd] = useMemo((): [number, number] => {
    if (view === 'full') return [0, 1440]
    const marks: number[] = []
    for (const b of blocks) marks.push(b.startMin, b.endMin)
    for (const a of actual) marks.push(a.startMin, a.endMin)
    if (isToday) marks.push(nowMin)
    return viewWindow(marks)
  }, [view, blocks, actual, isToday, nowMin])

  const laneHeight = (viewEnd - viewStart) * ppm
  const toY = (min: number): number => (clampMin(min) - viewStart) * ppm
  const toMin = (clientY: number): number => {
    const rect = laneRef.current?.getBoundingClientRect()
    if (!rect) return viewStart
    return clampMin(viewStart + (clientY - rect.top) / ppm)
  }

  // 首次进入某一天时滚到当前时间附近，不用手动找
  useLayoutEffect(() => {
    if (!scrollRef.current || scrolledFor.current === day) return
    scrolledFor.current = day
    const target = isToday ? nowMin : blocks[0]?.startMin ?? viewStart
    scrollRef.current.scrollTop = Math.max(0, toY(target) - 120)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, blocks.length, viewStart, ppm])

  const activeTasks = useMemo(
    () => tasks.filter((t) => ACTIVE_STATUS.has(t.status) && !isFinishedEvent(t, new Date())),
    [tasks]
  )
  const taskTitle = useCallback(
    (id: string | null) => (id ? tasks.find((t) => t.id === id)?.title ?? null : null),
    [tasks]
  )

  const suggested = useMemo(() => templateForDate(templates, day), [templates, day])
  const appliedTemplateIds = useMemo(
    () => new Set(blocks.map((b) => b.templateId).filter(Boolean)),
    [blocks]
  )
  const planned = useMemo(() => plannedMinutes(blocks), [blocks])
  // 超载提示：一天排超过 14 小时，多半是排太满而不是真打算这么过
  const overloaded = planned > 14 * 60

  // ---- 拖动已有块 ----
  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent): void => {
      const deltaMin = snap((e.clientY - drag.originY) / ppm)
      setDrag((d) => {
        if (!d) return d
        if (d.mode === 'move') {
          const span = d.endMin - d.startMin
          const start = Math.max(0, Math.min(1440 - span, snap(d.startMin) + deltaMin))
          return { ...d, preview: { startMin: start, endMin: start + span } }
        }
        const end = Math.max(d.startMin + SNAP, Math.min(1440, snap(d.endMin) + deltaMin))
        return { ...d, preview: { startMin: d.startMin, endMin: end } }
      })
    }
    const onUp = (): void => {
      setDrag((d) => {
        if (d && (d.preview.startMin !== d.startMin || d.preview.endMin !== d.endMin)) {
          void api
            .plugin('timeblock', 'update', d.id, {
              startMin: d.preview.startMin,
              endMin: d.preview.endMin
            })
            .then(load)
        }
        return null
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, load, ppm])

  const beginDrag = (e: React.MouseEvent, b: TimeBlock, mode: DragMode): void => {
    e.preventDefault()
    e.stopPropagation()
    setDrag({
      id: b.id,
      mode,
      originY: e.clientY,
      startMin: b.startMin,
      endMin: b.endMin,
      preview: { startMin: b.startMin, endMin: b.endMin }
    })
  }

  // ---- 空白处框选建块 ----
  useEffect(() => {
    if (!select) return
    const onMove = (e: MouseEvent): void => {
      const cur = snap(toMin(e.clientY))
      setSelect((s) => (s ? { ...s, cursorMin: cur } : s))
    }
    const onUp = (): void => {
      setSelect((s) => {
        if (!s) return null
        const lo = Math.min(s.anchorMin, s.cursorMin)
        const hi = Math.max(s.anchorMin, s.cursorMin)
        // 拖得太短当成「点了一下」，给个默认一小时
        const span = hi - lo < SNAP * 2 ? 60 : hi - lo
        openDraft(Math.min(lo, 1440 - span), span)
        return null
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [select, ppm, viewStart])

  const beginSelect = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== laneRef.current || drag) return
    e.preventDefault()
    const at = snap(toMin(e.clientY))
    setSelect({ anchorMin: at, cursorMin: at })
  }

  // ---- 增删改 ----
  const openDraft = (startMin: number, span = 60): void =>
    setDraft({
      id: null,
      startMin: clampMin(startMin),
      endMin: clampMin(startMin + span),
      title: '',
      tag: '',
      taskId: null
    })

  const editDraft = (b: TimeBlock): void =>
    setDraft({
      id: b.id,
      startMin: b.startMin,
      endMin: b.endMin,
      title: b.title,
      tag: b.tag ?? '',
      taskId: b.taskId
    })

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    if (!draft.title.trim()) return flash('写一句要做什么')
    if (draft.startMin >= draft.endMin) return flash('结束时间要晚于开始时间')
    const payload = {
      startMin: draft.startMin,
      endMin: draft.endMin,
      title: draft.title.trim(),
      tag: draft.tag.trim() || null,
      taskId: draft.taskId
    }
    if (draft.id) await api.plugin('timeblock', 'update', draft.id, payload)
    else
      await api.plugin('timeblock', 'create', { ...payload, date: day, done: false, templateId: null })
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

  const copyToTomorrow = async (b: TimeBlock): Promise<void> => {
    await api.plugin('timeblock', 'copy', b.id, shiftDay(day, 1))
    flash('已复制到明天')
  }

  const copyDayToTomorrow = async (): Promise<void> => {
    const n = await api.plugin<number>('timeblock', 'copy-day', day, shiftDay(day, 1))
    flash(n ? `已把 ${n} 个块复制到明天` : '明天已经有相同的安排了')
  }

  const applyTpl = async (id: string): Promise<void> => {
    const created = (await api.plugin('timeblock', 'template-apply', id, day)) as TimeBlock[]
    setTemplatesOpen(false)
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

  const startFocus = async (b: TimeBlock): Promise<void> => {
    const minutes = Math.max(1, Math.min(180, b.endMin - b.startMin))
    await api.plugin('pomodoro', 'start', 'focus', minutes, b.id, b.taskId, taskTitle(b.taskId) ?? b.title)
    flash(`已开始专注 ${minutes} 分钟`)
  }

  const hours = useMemo(() => {
    const out: number[] = []
    for (let h = Math.floor(viewStart / 60); h <= Math.ceil(viewEnd / 60); h++) out.push(h)
    return out
  }, [viewStart, viewEnd])

  const selLo = select ? Math.min(select.anchorMin, select.cursorMin) : 0
  const selHi = select ? Math.max(select.anchorMin, select.cursorMin) : 0

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">作息</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              这里排的是「几点到几点做什么」。有截止时间的任务在「日程」页，两边不重复。
            </p>
          </div>
          <DayNav day={day} onChange={setDay} />
        </div>

        {/* 工具栏：视图 / 密度 / 模板 / 复制 */}
        <div className="relative mt-3 flex flex-wrap items-center gap-2">
          <Segmented
            value={view}
            options={[
              ['auto', '有内容的时段'],
              ['full', '全天']
            ]}
            onChange={setView}
          />
          <Segmented
            value={density}
            options={[
              ['compact', '紧凑'],
              ['normal', '标准'],
              ['roomy', '宽松']
            ]}
            onChange={setDensity}
          />

          <button
            onClick={() => setTemplatesOpen((v) => !v)}
            className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:border-brand hover:text-brand"
          >
            模板 {templates.length > 0 && <span className="tabular-nums">({templates.length})</span>} ▾
          </button>
          {blocks.length > 0 && (
            <button
              onClick={() => void copyDayToTomorrow()}
              className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:border-brand hover:text-brand"
            >
              整天复制到明天
            </button>
          )}

          <span className="ml-auto text-xs text-slate-400">
            已排 <span className="font-medium text-slate-600">{durationLabel(0, planned)}</span> ·{' '}
            {blocks.length} 个块
          </span>

          {templatesOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setTemplatesOpen(false)} />
              <div className="absolute top-9 left-0 z-20 w-72 rounded-xl border border-slate-200 bg-surface p-3 shadow-lg">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">模板</span>
                  <button
                    onClick={() => {
                      setTemplatesOpen(false)
                      setSavingTemplate(true)
                    }}
                    className="text-xs text-brand hover:underline"
                  >
                    把今天存为模板
                  </button>
                </div>
                {templates.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    还没有模板。先排好一天，再存下来，之后一键套用或按星期自动提示。
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {templates.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{t.name}</span>
                          <span className="block text-[11px] text-slate-400">
                            {templateBlocks.filter((b) => b.templateId === t.id).length} 个块 ·{' '}
                            {weekdaysLabel(t.weekdays)}
                          </span>
                        </span>
                        <span className="flex shrink-0 gap-2 text-xs">
                          <button onClick={() => void applyTpl(t.id)} className="text-brand hover:underline">
                            套用
                          </button>
                          <button
                            onClick={() => void deleteTpl(t.id)}
                            className="text-slate-300 hover:text-red-500"
                          >
                            删除
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        {overloaded && (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            今天已经排了 {durationLabel(0, planned)}。排得太满通常等于什么都排不成——留点空档给意外。
          </p>
        )}
      </header>

      {suggested && !appliedTemplateIds.has(suggested.id) && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-brand/30 bg-brand-soft px-4 py-2.5 text-sm">
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

      <div
        ref={scrollRef}
        className="max-h-[calc(100vh-16rem)] overflow-y-auto rounded-xl border border-slate-200 bg-surface p-4 shadow-sm"
      >
        <div className="flex">
          <div className="relative w-12 shrink-0" style={{ height: laneHeight }}>
            {hours.map((h) => (
              <div
                key={h}
                className="absolute left-0 text-[11px] text-slate-300 tabular-nums"
                style={{ top: toY(h * 60) - 6 }}
              >
                {String(Math.min(h, 24)).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          <div
            ref={laneRef}
            onMouseDown={beginSelect}
            className={`relative flex-1 rounded-md bg-slate-50/60 ${
              drag ? 'cursor-grabbing' : select ? 'cursor-ns-resize' : 'cursor-crosshair'
            }`}
            style={{ height: laneHeight }}
            title="按住往下拖，框选一段时间"
          >
            {hours.map((h) => (
              <div
                key={h}
                className="pointer-events-none absolute inset-x-0 border-t border-slate-100"
                style={{ top: toY(h * 60) }}
              />
            ))}

            {/* 当前时间线 */}
            {isToday && nowMin >= viewStart && nowMin <= viewEnd && (
              <div
                className="pointer-events-none absolute inset-x-0 z-20 border-t border-red-400/70"
                style={{ top: toY(nowMin) }}
              >
                <span className="absolute -top-1 -left-1 size-2 rounded-full bg-red-400" />
              </div>
            )}

            {/* 框选中的预览 */}
            {select && selHi > selLo && (
              <div
                className="pointer-events-none absolute inset-x-1 z-10 rounded-md border-2 border-dashed border-brand/60 bg-brand-soft/70"
                style={{ top: toY(selLo), height: Math.max(4, (selHi - selLo) * ppm) }}
              >
                <span className="absolute inset-x-0 top-1 text-center text-[10px] font-medium text-brand tabular-nums">
                  {minutesToLabel(selLo)}–{minutesToLabel(selHi)}（{durationLabel(selLo, selHi)}）
                </span>
              </div>
            )}

            {blocks
              .filter((b) => b.endMin > viewStart && b.startMin < viewEnd)
              .map((b) => {
                const dragging = drag?.id === b.id
                const startMin = dragging ? drag.preview.startMin : b.startMin
                const endMin = dragging ? drag.preview.endMin : b.endMin
                const height = Math.max(16, (endMin - startMin) * ppm - 2)
                const tight = height < 42 // 太矮就只留一行，别把字挤成两截
                const coverage = actual.length ? coverageOf({ startMin, endMin }, actual) : null
                const clash = conflictsWith(blocks, b, b.id).length > 0
                const linked = taskTitle(b.taskId)
                return (
                  <div
                    key={b.id}
                    onMouseDown={(e) => beginDrag(e, b, 'move')}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!dragging) editDraft(b)
                    }}
                    style={{ top: toY(startMin), height }}
                    className={`group absolute inset-x-1 overflow-hidden rounded-md border px-2 py-1 text-left text-xs transition-shadow ${
                      dragging ? 'z-30 shadow-md' : ''
                    } ${
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
                        onMouseDown={(e) => e.stopPropagation()}
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
                      {tight && (
                        <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">
                          {minutesToLabel(startMin)}
                        </span>
                      )}
                      <span className="ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {pomodoroEnabled && !b.done && (
                          <button
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation()
                              void startFocus(b)
                            }}
                            className="rounded bg-white/80 px-1 text-[10px] text-brand"
                            title="用这段时长开始一轮专注"
                          >
                            专注
                          </button>
                        )}
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            void copyToTomorrow(b)
                          }}
                          className="rounded bg-white/80 px-1 text-[10px] text-slate-500"
                          title="复制到明天"
                        >
                          明天
                        </button>
                      </span>
                    </div>
                    {!tight && (
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-400 tabular-nums">
                        <span>
                          {minutesToLabel(startMin)}–{minutesToLabel(endMin)}
                        </span>
                        {b.tag && <span className="rounded bg-white/70 px-1">{b.tag}</span>}
                        {linked && (
                          <span className="truncate text-brand" title={linked}>
                            {linked}
                          </span>
                        )}
                        {b.focusMinutes > 0 && (
                          <span className="text-brand" title="「专注」插件回写的累计专注时长">
                            专注 {durationLabel(0, b.focusMinutes)}
                          </span>
                        )}
                        {coverage !== null && coverage > 0.05 && (
                          <span title="这段计划被实际活动覆盖的比例">
                            实际 {Math.round(coverage * 100)}%
                          </span>
                        )}
                      </div>
                    )}
                    {/* 下沿拉伸把手 */}
                    <div
                      onMouseDown={(e) => beginDrag(e, b, 'resize')}
                      className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize opacity-0 transition-opacity group-hover:opacity-100"
                      title="拖动改时长"
                    >
                      <div className="mx-auto h-0.5 w-8 rounded-full bg-brand/50" />
                    </div>
                  </div>
                )
              })}
          </div>

          {sessions.length > 0 && (
            <div className="relative ml-3 w-32 shrink-0 border-l border-slate-100 pl-2" style={{ height: laneHeight }}>
              {sessions.map((s, i) => {
                const height = Math.max(18, (s.endMin - s.startMin) * ppm - 2)
                return (
                  <div
                    key={`${s.label}-${i}`}
                    title={`${s.label} · ${minutesToLabel(s.startMin)}–${minutesToLabel(s.endMin)} · 实际投入 ${durationLabel(0, s.activeMin)}`}
                    className="absolute inset-x-0 overflow-hidden rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5"
                    style={{ top: toY(s.startMin), height }}
                  >
                    <div className="truncate text-[10px] font-medium text-emerald-800">{s.label}</div>
                    {height >= 30 && (
                      <div className="truncate text-[10px] text-emerald-600 tabular-nums">
                        {durationLabel(0, s.activeMin)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <p className="mt-2 text-[11px] text-slate-300">
        空白处按住往下拖可以框选一段时间建块；块本身可拖动改时间，拖下沿改时长。
        {sessions.length > 0 && ' 右侧绿色是屏幕感知记到的、你今天真正花了时间的事。'}
      </p>

      {draft && (
        <Modal panelClass="w-[23rem] rounded-xl bg-surface p-5 shadow-xl" onClose={() => setDraft(null)}>
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
                  onChange={(v) =>
                    setDraft({ ...draft, startMin: v, endMin: Math.max(v + SNAP, draft.endMin) })
                  }
                  label="开始"
                />
                <span className="pt-4 text-slate-300">–</span>
                <TimeInput
                  value={draft.endMin}
                  onChange={(v) => setDraft({ ...draft, endMin: v })}
                  label="结束"
                />
              </div>

              <div>
                <div className="mb-1.5 text-xs text-slate-400">
                  时长 · 当前 {durationLabel(draft.startMin, draft.endMin)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {DURATION_PRESETS.map((m) => {
                    const active = draft.endMin - draft.startMin === m
                    return (
                      <button
                        key={m}
                        onClick={() => setDraft({ ...draft, endMin: Math.min(1440, draft.startMin + m) })}
                        className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
                          active
                            ? 'border-brand bg-brand-soft text-brand'
                            : 'border-slate-200 text-slate-500 hover:border-slate-300'
                        }`}
                      >
                        {m} 分
                      </button>
                    )
                  })}
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">关联任务（可选）</span>
                <select
                  value={draft.taskId ?? ''}
                  onChange={(e) => {
                    const id = e.target.value || null
                    const t = activeTasks.find((x) => x.id === id)
                    setDraft({ ...draft, taskId: id, title: draft.title || t?.title || '' })
                  }}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
                >
                  <option value="">不关联</option>
                  {activeTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>

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
                        setTemplateDays((ds) => (ds.includes(i) ? ds.filter((d) => d !== i) : [...ds, i]))
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
