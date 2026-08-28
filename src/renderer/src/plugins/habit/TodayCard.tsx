// 今日页卡片：今天还差哪几个没打卡，直接在卡片上就能打。
import { useCallback, useEffect, useState } from 'react'
import type { HabitView } from '@shared/habit'
import { api } from '../../api'

export default function HabitTodayCard(): React.JSX.Element | null {
  const [habits, setHabits] = useState<HabitView[]>([])

  const load = useCallback(async () => {
    const res = await api.plugin<{ habits: HabitView[] }>('habit', 'list')
    setHabits(res.habits)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!habits.length) return null

  const done = habits.filter((h) => h.checkedToday).length
  const check = async (h: HabitView): Promise<void> => {
    await api.plugin('habit', h.checkedToday ? 'uncheck' : 'check', h.id)
    await load()
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">打卡</span>
        <span className="text-xs text-slate-400 tabular-nums">
          {done}/{habits.length}
        </span>
      </div>
      <ul className="space-y-1.5">
        {habits.slice(0, 5).map((h) => (
          <li key={h.id}>
            <button
              onClick={() => void check(h)}
              className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-slate-50"
            >
              <span
                className={`size-3.5 shrink-0 rounded border ${
                  h.checkedToday ? 'border-brand bg-brand' : 'border-slate-300'
                }`}
              />
              <span className={`truncate text-sm ${h.checkedToday ? 'text-slate-400 line-through' : ''}`}>
                {h.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
