// 今日页卡片：今天专注了多久，以及是否还有一轮在跑。
import { useEffect, useState } from 'react'
import {
  focusLabel,
  formatCountdown,
  remainingSeconds,
  type DayStats,
  type PomodoroSession
} from '@shared/pomodoro'
import { api } from '../../api'

export default function PomodoroTodayCard(): React.JSX.Element {
  const [stats, setStats] = useState<DayStats>({ rounds: 0, focusMinutes: 0, abandoned: 0 })
  const [running, setRunning] = useState<PomodoroSession | null>(null)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    void api.plugin<{ stats: DayStats }>('pomodoro', 'today').then((r) => setStats(r.stats))
    void api.plugin<PomodoroSession | null>('pomodoro', 'running').then(setRunning)
  }, [])

  useEffect(() => {
    if (!running) return
    const tick = (): void => setRemaining(remainingSeconds(running.startAt, running.minutes, Date.now()))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [running])

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-2 text-xs font-medium text-slate-400">专注</div>
      {running && remaining > 0 ? (
        <div>
          <div className="text-2xl font-semibold tabular-nums">{formatCountdown(remaining)}</div>
          <div className="mt-0.5 text-xs text-slate-400">
            {running.kind === 'focus' ? '专注中' : '休息中'}
          </div>
        </div>
      ) : (
        <div>
          <div className="text-2xl font-semibold tabular-nums">{stats.rounds}</div>
          <div className="mt-0.5 text-xs text-slate-400">
            今天完成的轮数 · {focusLabel(stats.focusMinutes)}
          </div>
        </div>
      )}
    </div>
  )
}
