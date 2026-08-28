// 打卡页：每日小目标的清单、频率、跳过与回顾。
//
// 口径上刻意不做惩罚：今天还没打不算断，主动跳过不断签，断了也不清零累计。
// 这一页应该让人想再来，而不是每天开局先看一眼自己搞砸了什么。
import { useCallback, useEffect, useState } from 'react'
import type { DayState, Habit, HabitCheck, HabitFrequency, HabitView } from '@shared/habit'
import { frequencyLabel, shiftDate } from '@shared/habit'
import { api } from '../../api'
import Modal from '../../components/Modal'
import { Section, Segmented } from '../../components/ui'

interface ListPayload {
  habits: HabitView[]
  today: string
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const WINDOW_DAYS = 84 // 12 周热力图

const STATE_CLASS: Record<DayState, string> = {
  done: 'bg-brand',
  skipped: 'bg-amber-200',
  missed: 'bg-slate-100',
  off: 'bg-slate-50'
}
const STATE_LABEL: Record<DayState, string> = {
  done: '已完成',
  skipped: '已跳过',
  missed: '没做',
  off: '不需要做'
}

export default function HabitPage(): React.JSX.Element {
  const [habits, setHabits] = useState<HabitView[]>([])
  const [today, setToday] = useState('')
  const [note, setNote] = useState('')
  const [archived, setArchived] = useState<Habit[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<HabitView | null>(null)
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState<HabitView | null>(null)

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2600)
  }

  const load = useCallback(async () => {
    const res = await api.plugin<ListPayload>('habit', 'list', WINDOW_DAYS)
    setHabits(res.habits)
    setToday(res.today)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (showArchived) void api.plugin<Habit[]>('habit', 'archived').then(setArchived)
  }, [showArchived, habits])

  const toggle = async (h: HabitView): Promise<void> => {
    await api.plugin('habit', h.checkedToday || h.skippedToday ? 'uncheck' : 'check', h.id)
    await load()
  }

  const skip = async (h: HabitView): Promise<void> => {
    await api.plugin('habit', 'skip', h.id)
    await load()
    flash('今天记为跳过，连续不会断')
  }

  const archive = async (h: HabitView): Promise<void> => {
    if (!window.confirm(`归档「${h.name}」？历史打卡会保留，随时可以恢复。`)) return
    await api.plugin('habit', 'archive', h.id)
    await load()
  }

  const move = async (h: HabitView, delta: number): Promise<void> => {
    await api.plugin('habit', 'reorder', h.id, delta)
    await load()
  }

  const doneToday = habits.filter((h) => h.dueToday && h.checkedToday).length
  const dueToday = habits.filter((h) => h.dueToday && !h.skippedToday).length

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">打卡</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            立小到不会失败的每日目标。今天没打不算断，主动跳过也不断，断了还不清零累计。
          </p>
          {habits.length > 0 && (
            <p className="mt-2 text-sm text-slate-500">
              今天完成 <span className="font-medium text-brand">{doneToday}</span> / {dueToday}
              {habits.length > dueToday && (
                <span className="ml-2 text-xs text-slate-400">
                  （另有 {habits.length - dueToday} 个今天不用做）
                </span>
              )}
            </p>
          )}
        </div>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
        >
          新建习惯
        </button>
      </header>

      {habits.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-5 py-10 text-center text-sm text-slate-400">
          还没有习惯。第一个目标越小越好——小到你今天一定做得到。
        </p>
      ) : (
        <ul className="space-y-3">
          {habits.map((h, i) => (
            <li key={h.id} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => void toggle(h)}
                  aria-label={h.checkedToday ? `撤销「${h.name}」今天的打卡` : `给「${h.name}」打卡`}
                  className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors ${
                    h.checkedToday
                      ? 'border-brand bg-brand text-white'
                      : h.skippedToday
                        ? 'border-amber-300 bg-amber-100 text-amber-600'
                        : h.dueToday
                          ? 'border-slate-300 text-transparent hover:border-brand'
                          : 'border-slate-200 text-transparent'
                  }`}
                  title={h.skippedToday ? '今天已跳过' : h.dueToday ? '' : '今天不用做'}
                >
                  {h.skippedToday ? (
                    <span className="text-xs">–</span>
                  ) : (
                    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => setDetail(h)}
                      className={`truncate text-left text-sm font-medium hover:text-brand ${
                        h.checkedToday ? 'text-slate-400' : ''
                      }`}
                    >
                      {h.name}
                    </button>
                    <div className="flex shrink-0 items-center gap-1.5 text-xs text-slate-300">
                      <button onClick={() => void move(h, -1)} disabled={i === 0} className="hover:text-slate-600 disabled:opacity-30" title="上移">
                        ↑
                      </button>
                      <button onClick={() => void move(h, 1)} disabled={i === habits.length - 1} className="hover:text-slate-600 disabled:opacity-30" title="下移">
                        ↓
                      </button>
                      {h.dueToday && !h.checkedToday && !h.skippedToday && (
                        <button onClick={() => void skip(h)} className="hover:text-amber-600" title="今天做不了，记为跳过（连续不断）">
                          跳过
                        </button>
                      )}
                      <button onClick={() => setEditing(h)} className="hover:text-slate-600">
                        编辑
                      </button>
                      <button onClick={() => void archive(h)} className="hover:text-slate-600">
                        归档
                      </button>
                    </div>
                  </div>

                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-400 tabular-nums">
                    <span>{h.frequencyLabel}</span>
                    <span>
                      连续 <span className="font-medium text-slate-600">{h.streak}</span>
                      {h.frequency.kind === 'weekly' ? ' 周' : ' 天'}
                    </span>
                    <span>累计 {h.total} 次</span>
                    {h.bestStreak > h.streak && <span>最长 {h.bestStreak}</span>}
                    <span title="最近 12 周里，该做的日子完成了多少">
                      完成率 {Math.round(h.rate * 100)}%
                    </span>
                  </div>

                  <Heatmap recent={h.recent} today={today} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex items-center gap-4 text-[11px] text-slate-400">
        <LegendDot cls={STATE_CLASS.done} label="完成" />
        <LegendDot cls={STATE_CLASS.skipped} label="跳过" />
        <LegendDot cls={STATE_CLASS.missed} label="没做" />
        <LegendDot cls={STATE_CLASS.off} label="不用做" />
      </div>

      <div className="mt-8">
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          {showArchived ? '收起' : '查看'}已归档的习惯
        </button>
        {showArchived && (
          <ul className="mt-3 space-y-1.5">
            {archived.length === 0 ? (
              <li className="text-xs text-slate-300">没有已归档的习惯。</li>
            ) : (
              archived.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm text-slate-400"
                >
                  <span>
                    {h.name}
                    <span className="ml-2 text-xs text-slate-300">{frequencyLabel(h.frequency)}</span>
                  </span>
                  <span className="flex gap-3 text-xs">
                    <button
                      onClick={() => void api.plugin('habit', 'unarchive', h.id).then(load)}
                      className="text-brand hover:underline"
                    >
                      恢复
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(`彻底删除「${h.name}」及其全部打卡记录？不可恢复。`)) return
                        void api.plugin('habit', 'destroy', h.id).then(load)
                      }}
                      className="text-slate-300 hover:text-red-500"
                    >
                      删除
                    </button>
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {(creating || editing) && (
        <HabitEditor
          habit={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={async (msg) => {
            setCreating(false)
            setEditing(null)
            await load()
            if (msg) flash(msg)
          }}
        />
      )}

      {detail && <HabitDetail habit={detail} onClose={() => setDetail(null)} />}

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

function LegendDot({ cls, label }: { cls: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-2.5 rounded-sm ${cls}`} />
      {label}
    </span>
  )
}

/** 12 周热力图：一列一周，一格一天。 */
function Heatmap({ recent, today }: { recent: DayState[]; today: string }): React.JSX.Element {
  const weeks: { date: string; state: DayState }[][] = []
  recent.forEach((state, i) => {
    const date = shiftDate(today, -(recent.length - 1 - i))
    const col = Math.floor(i / 7)
    if (!weeks[col]) weeks[col] = []
    weeks[col].push({ date, state })
  })
  return (
    <div className="mt-2 flex gap-[3px] overflow-x-auto">
      {weeks.map((week, i) => (
        <div key={i} className="flex flex-col gap-[3px]">
          {week.map((d) => (
            <span
              key={d.date}
              title={`${d.date} · ${STATE_LABEL[d.state]}`}
              className={`size-2.5 rounded-sm ${STATE_CLASS[d.state]}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** 新建 / 编辑：名字 + 频率。 */
function HabitEditor({
  habit,
  onClose,
  onSaved
}: {
  habit: HabitView | null
  onClose: () => void
  onSaved: (msg?: string) => void | Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(habit?.name ?? '')
  const [kind, setKind] = useState<HabitFrequency['kind']>(habit?.frequency.kind ?? 'daily')
  const [days, setDays] = useState<number[]>(
    habit?.frequency.kind === 'weekdays' ? habit.frequency.days : [1, 2, 3, 4, 5]
  )
  const [times, setTimes] = useState(habit?.frequency.kind === 'weekly' ? habit.frequency.times : 3)
  const [err, setErr] = useState('')

  const frequency = (): HabitFrequency =>
    kind === 'daily'
      ? { kind: 'daily' }
      : kind === 'weekly'
        ? { kind: 'weekly', times }
        : { kind: 'weekdays', days }

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return setErr('名字不能为空')
    if (kind === 'weekdays' && days.length === 0) return setErr('至少选一天')
    if (habit) {
      await api.plugin('habit', 'update', habit.id, { name: trimmed, frequency: frequency() })
      void onSaved('已保存')
    } else {
      const res = await api.plugin<{ ok: boolean; error?: string }>(
        'habit',
        'create',
        trimmed,
        frequency()
      )
      if (!res.ok) return setErr(res.error ?? '没能添加')
      void onSaved()
    }
  }

  return (
    <Modal panelClass="w-[24rem] rounded-xl bg-surface p-5 shadow-xl" onClose={onClose}>
      {(close) => (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{habit ? '编辑习惯' : '新建习惯'}</h2>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setErr('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="比如「走 20 分钟」"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
          />

          <div>
            <div className="mb-1.5 text-xs text-slate-400">多久做一次</div>
            <Segmented
              value={kind}
              options={[
                ['daily', '每天'],
                ['weekdays', '指定星期'],
                ['weekly', '每周 N 次']
              ]}
              onChange={(v) => setKind(v as HabitFrequency['kind'])}
            />
          </div>

          {kind === 'weekdays' && (
            <div className="flex gap-1">
              {WEEKDAYS.map((label, i) => (
                <button
                  key={i}
                  onClick={() =>
                    setDays((ds) => (ds.includes(i) ? ds.filter((d) => d !== i) : [...ds, i]))
                  }
                  className={`size-7 rounded-md border text-xs transition-colors ${
                    days.includes(i)
                      ? 'border-brand bg-brand-soft text-brand'
                      : 'border-slate-200 text-slate-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {kind === 'weekly' && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-xs text-slate-400">每周</span>
              <input
                type="number"
                min={1}
                max={7}
                value={times}
                onChange={(e) => setTimes(Number(e.target.value))}
                className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-brand"
              />
              <span className="text-xs text-slate-400">次，哪天做都行</span>
            </label>
          )}

          {err && <p className="text-xs text-red-500">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={close} className="rounded-lg px-3 py-1.5 text-sm text-slate-500">
              取消
            </button>
            <button
              onClick={() => void submit()}
              className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white"
            >
              保存
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** 详情：看这个习惯的打卡记录与备注。 */
function HabitDetail({ habit, onClose }: { habit: HabitView; onClose: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<HabitCheck[]>([])

  useEffect(() => {
    void api.plugin<HabitCheck[]>('habit', 'history', habit.id).then(setRows)
  }, [habit.id])

  return (
    <Modal panelClass="w-[26rem] rounded-xl bg-surface p-5 shadow-xl" onClose={onClose}>
      {(close) => (
        <div>
          <h2 className="text-base font-semibold">{habit.name}</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {habit.frequencyLabel} · 连续 {habit.streak} · 累计 {habit.total} 次 · 完成率{' '}
            {Math.round(habit.rate * 100)}%
          </p>

          <div className="mt-4 max-h-72 overflow-y-auto">
            {rows.length === 0 ? (
              <p className="text-xs text-slate-400">还没有记录。</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {rows.map((r) => (
                  <li key={r.date} className="flex items-baseline gap-3 py-2">
                    <span className="w-24 shrink-0 text-xs text-slate-400 tabular-nums">{r.date}</span>
                    <span
                      className={`w-10 shrink-0 text-xs ${r.skipped ? 'text-amber-600' : 'text-brand'}`}
                    >
                      {r.skipped ? '跳过' : '完成'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-slate-500">{r.note ?? ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <button onClick={close} className="rounded-lg px-3 py-1.5 text-sm text-slate-500">
              关闭
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
