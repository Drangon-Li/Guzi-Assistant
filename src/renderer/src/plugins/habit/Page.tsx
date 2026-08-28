// 打卡页：每日小目标的清单与打卡。
//
// 口径上刻意不做惩罚：今天还没打不算断，断了也不清零累计。这一页应该让人想再来，
// 而不是每天开局先看一眼自己搞砸了什么。
import { useCallback, useEffect, useState } from 'react'
import type { Habit, HabitView } from '@shared/habit'
import { shiftDate } from '@shared/habit'
import { api } from '../../api'

interface ListPayload {
  habits: HabitView[]
  today: string
}

export default function HabitPage(): React.JSX.Element {
  const [habits, setHabits] = useState<HabitView[]>([])
  const [today, setToday] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [archived, setArchived] = useState<Habit[]>([])
  const [showArchived, setShowArchived] = useState(false)

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2400)
  }

  const load = useCallback(async () => {
    const res = await api.plugin<ListPayload>('habit', 'list')
    setHabits(res.habits)
    setToday(res.today)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (showArchived) void api.plugin<Habit[]>('habit', 'archived').then(setArchived)
  }, [showArchived, habits])

  const add = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    const res = await api.plugin<{ ok: boolean; error?: string }>('habit', 'create', trimmed)
    if (!res.ok) return flash(res.error ?? '没能添加')
    setName('')
    await load()
  }

  const toggle = async (h: HabitView): Promise<void> => {
    await api.plugin('habit', h.checkedToday ? 'uncheck' : 'check', h.id)
    await load()
  }

  const archive = async (h: HabitView): Promise<void> => {
    if (!window.confirm(`归档「${h.name}」？历史打卡会保留，随时可以恢复。`)) return
    await api.plugin('habit', 'archive', h.id)
    await load()
  }

  const unarchive = async (id: string): Promise<void> => {
    await api.plugin('habit', 'unarchive', id)
    await load()
  }

  const doneToday = habits.filter((h) => h.checkedToday).length

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header className="mb-5">
        <h1 className="text-lg font-semibold">打卡</h1>
        <p className="mt-0.5 text-xs text-slate-400">
          立小到不会失败的每日目标。今天没打不算断，断了也不清零——只看累计和当前连续。
        </p>
        {habits.length > 0 && (
          <p className="mt-2 text-sm text-slate-500">
            今天完成 <span className="font-medium text-brand">{doneToday}</span> / {habits.length}
          </p>
        )}
      </header>

      <div className="mb-5 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder="新的小目标，比如「走 20 分钟」"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={() => void add()}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
        >
          添加
        </button>
      </div>

      {habits.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-5 py-10 text-center text-sm text-slate-400">
          还没有习惯。第一个目标越小越好——小到你今天一定做得到。
        </p>
      ) : (
        <ul className="space-y-3">
          {habits.map((h) => (
            <li key={h.id} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => void toggle(h)}
                  aria-label={h.checkedToday ? `撤销「${h.name}」今天的打卡` : `给「${h.name}」打卡`}
                  className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors ${
                    h.checkedToday
                      ? 'border-brand bg-brand text-white'
                      : 'border-slate-300 text-transparent hover:border-brand'
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-medium ${h.checkedToday ? 'text-slate-400' : ''}`}>
                      {h.name}
                    </span>
                    <button
                      onClick={() => void archive(h)}
                      className="shrink-0 text-xs text-slate-300 hover:text-slate-500"
                    >
                      归档
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-400 tabular-nums">
                    <span>
                      连续 <span className="font-medium text-slate-600">{h.streak}</span> 天
                    </span>
                    <span>累计 {h.total} 次</span>
                    {h.bestStreak > h.streak && <span>最长 {h.bestStreak} 天</span>}
                  </div>
                  <MiniCalendar recent={h.recent} today={today} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

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
                  <span>{h.name}</span>
                  <button onClick={() => void unarchive(h.id)} className="text-xs text-brand hover:underline">
                    恢复
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

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

/** 最近 28 天的小格子；最后一格是今天。 */
function MiniCalendar({ recent, today }: { recent: boolean[]; today: string }): React.JSX.Element {
  return (
    <div className="mt-2 flex gap-[3px]">
      {recent.map((on, i) => {
        const date = shiftDate(today, -(recent.length - 1 - i))
        return (
          <span
            key={date}
            title={`${date}${on ? ' 已打卡' : ''}`}
            className={`h-3 flex-1 rounded-sm ${on ? 'bg-brand' : 'bg-slate-100'}`}
          />
        )
      })}
    </div>
  )
}
