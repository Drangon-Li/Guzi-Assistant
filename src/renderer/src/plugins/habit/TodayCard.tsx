// 今日页卡片：今天还差哪几个没打卡，直接在卡片上就能打。
import { useCallback, useEffect, useState } from 'react'
import { todayProgress, type HabitView } from '@shared/habit'
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

  // 今天不用做的（频率没排到今天）不占卡片位置，也不进分母
  const due = habits.filter((h) => h.dueToday)
  const progress = todayProgress(habits)
  const check = async (h: HabitView): Promise<void> => {
    await api.plugin('habit', h.checkedToday || h.skippedToday ? 'uncheck' : 'check', h.id)
    await load()
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">打卡</span>
        <span className="text-xs text-slate-400 tabular-nums">
          {progress.done}/{progress.total}
        </span>
      </div>
      {due.length === 0 ? (
        <p className="text-sm text-slate-400">今天没有要打的卡</p>
      ) : (
        <ul className="space-y-1.5">
          {due.slice(0, 5).map((h) => (
            <li key={h.id}>
              <button
                onClick={() => void check(h)}
                className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-slate-50"
              >
                <span
                  className={`size-3.5 shrink-0 rounded border ${
                    h.checkedToday
                      ? 'border-brand bg-brand'
                      : h.skippedToday
                        ? 'border-amber-300 bg-amber-200'
                        : 'border-slate-300'
                  }`}
                />
                <span
                  className={`truncate text-sm ${
                    h.checkedToday ? 'text-slate-400 line-through' : h.skippedToday ? 'text-slate-400' : ''
                  }`}
                >
                  {h.name}
                </span>
                {h.streak > 1 && (
                  <span className="ml-auto shrink-0 text-[11px] text-slate-300 tabular-nums">
                    {h.streak}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
