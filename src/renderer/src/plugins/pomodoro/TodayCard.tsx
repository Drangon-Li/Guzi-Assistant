// 今日页卡片：今天专注了多久、离目标还差多少，以及是否还有一轮在跑（含暂停态）。
import { useEffect, useState } from 'react'
import {
  DEFAULT_GOAL,
  DEFAULT_PREFS,
  focusLabel,
  formatCountdown,
  remainingSeconds,
  type DayStats,
  type PomodoroPrefs,
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
  const [prefs, setPrefs] = useState<PomodoroPrefs>(DEFAULT_PREFS)
  const [running, setRunning] = useState<PomodoroSession | null>(null)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    void api.plugin<{ stats: DayStats }>('pomodoro', 'today').then((r) => setStats(r.stats))
    void api.plugin<PomodoroPrefs>('pomodoro', 'prefs').then(setPrefs)
    void api.plugin<PomodoroSession | null>('pomodoro', 'running').then(setRunning)
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
