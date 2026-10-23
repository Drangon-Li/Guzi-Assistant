// 今日页卡片：今天专注了多久、离目标还差多少，以及是否还有一轮在跑（含暂停态）。
import { useEffect, useState } from 'react'
import {
  DEFAULT_GOAL,
  focusLabel,
  formatCountdown,
  remainingSeconds,
  type DayStats,
  type PomodoroSession
} from '@shared/pomodoro'
import { api } from '../../api'

export default function PomodoroTodayCard(): React.JSX.Element {
  const [stats, setStats] = useState<DayStats>({
    rounds: 0,
    focusMinutes: 0,
    abandoned: 0,
    goal: DEFAULT_GOAL,
    goalCurrent: 0,
    remainingToGoal: DEFAULT_GOAL.value,
    goalProgress: 0
  })
  const [running, setRunning] = useState<PomodoroSession | null>(null)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    let request = 0
    let disposed = false
    const refresh = async (): Promise<void> => {
      const current = ++request
      const [today, session] = await Promise.all([
        api.plugin<{ stats: DayStats }>('pomodoro', 'today'),
        api.plugin<PomodoroSession | null>('pomodoro', 'running')
      ])
      if (disposed || current !== request) return
      setStats(today.stats)
      setRunning(session)
    }
    const off = api.on('guzi-assistant:plugin-event', (payload) => {
      const { event } = payload as { event?: string }
      if (event === 'pomodoro:round-completed' || event === 'pomodoro:break-completed') {
        void refresh()
      }
    })
    void refresh()
    return () => {
      disposed = true
      off()
    }
  }, [])

  useEffect(() => {
    if (!running) return
    const tick = (): void => setRemaining(remainingSeconds(running, Date.now()))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const paused = !!running?.pausedAt

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">专注</span>
        <span className="text-xs text-slate-400 tabular-nums">
          {stats.goal.kind === 'rounds'
            ? `${stats.goalCurrent}/${stats.goal.value}`
            : `${stats.goalCurrent}/${stats.goal.value} 分`}
        </span>
      </div>
      {running && remaining > 0 ? (
        <div>
          <div className={`text-2xl font-semibold tabular-nums ${paused ? 'text-slate-300' : ''}`}>
            {formatCountdown(remaining)}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-400">
            {paused ? '已暂停' : running.kind === 'focus' ? '专注中' : '休息中'}
            {running.taskTitle ? ` · ${running.taskTitle}` : ''}
          </div>
        </div>
      ) : (
        <div>
          <div className="text-2xl font-semibold tabular-nums">{stats.rounds}</div>
          <div className="mt-0.5 text-xs text-slate-400">
            {focusLabel(stats.focusMinutes)}
            {stats.remainingToGoal > 0
              ? ` · 还差${stats.goal.kind === 'rounds' ? ` ${stats.remainingToGoal} 轮` : focusLabel(stats.remainingToGoal)}达标`
              : ' · 今天达标了'}
          </div>
        </div>
      )}
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${Math.round(stats.goalProgress * 100)}%` }}
        />
      </div>
    </div>
  )
}
