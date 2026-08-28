// 专注页的「设置」标签：时长参数 + 每日目标 + 自动开始。
//
// 刻意放在插件页内而不是核心设置页：插件的配置跟着插件走，停用插件时不会在设置里
// 留下一个孤零零的空分区，用户找配置也不用先想「这是核心功能还是插件功能」。
import { useEffect, useState } from 'react'
import {
  DEFAULT_PREFS,
  GOAL_LIMITS,
  focusLabel,
  type GoalKind,
  type PomodoroPrefs
} from '@shared/pomodoro'
import { api } from '../../api'
import { Section, Segmented, Toggle } from '../../components/ui'

type NumField = 'focusMin' | 'shortBreakMin' | 'longBreakMin' | 'roundsBeforeLongBreak'

const FIELDS: { key: NumField; label: string; hint: string; min: number; max: number }[] = [
  { key: 'focusMin', label: '一轮专注', hint: '分钟', min: 1, max: 180 },
  { key: 'shortBreakMin', label: '短休息', hint: '分钟', min: 1, max: 60 },
  { key: 'longBreakMin', label: '长休息', hint: '分钟', min: 1, max: 60 },
  { key: 'roundsBeforeLongBreak', label: '几轮后长休息', hint: '轮', min: 2, max: 12 }
]

/** 切换口径时给一个合理的等价值，而不是让用户从 8 分钟起步。 */
function convertGoal(kind: GoalKind, value: number, focusMin: number): number {
  const { min, max } = GOAL_LIMITS[kind]
  const raw = kind === 'minutes' ? value * focusMin : Math.round(value / Math.max(1, focusMin))
  return Math.max(min, Math.min(max, raw || min))
}

export default function PomodoroSettings({
  onChanged
}: {
  /** 改完通知父页面，好让目标环和统计跟着刷新 */
  onChanged?: (next: PomodoroPrefs) => void
}): React.JSX.Element {
  const [prefs, setPrefs] = useState<PomodoroPrefs>(DEFAULT_PREFS)

  useEffect(() => {
    void api.plugin<PomodoroPrefs>('pomodoro', 'prefs').then(setPrefs)
  }, [])

  const save = async (patch: Partial<PomodoroPrefs>): Promise<void> => {
    // 主进程会再夹一次范围，直接用回写值，避免本地显示和实际存的不一致
    const next = await api.plugin<PomodoroPrefs>('pomodoro', 'prefs-save', patch)
    setPrefs(next)
    onChanged?.(next)
  }

  const goal = prefs.dailyGoal
  const limits = GOAL_LIMITS[goal.kind]

  return (
    <Section title="专注" desc="番茄钟的时长与每日目标。改完立即生效，正在跑的那一轮不受影响。">
      <div className="grid grid-cols-2 gap-4">
        {FIELDS.map((f) => (
          <label key={f.key} className="text-sm">
            <span className="mb-1 block text-xs text-slate-400">{f.label}</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={f.min}
                max={f.max}
                value={prefs[f.key]}
                onChange={(e) => setPrefs({ ...prefs, [f.key]: Number(e.target.value) })}
                onBlur={(e) => void save({ [f.key]: Number(e.target.value) })}
                className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-brand"
              />
              <span className="text-xs text-slate-400">{f.hint}</span>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-4 border-t border-slate-100 pt-3">
        <div className="mb-1.5 text-xs text-slate-400">每日目标</div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={goal.kind}
            options={[
              ['rounds', '按轮数'],
              ['minutes', '按时长']
            ]}
            onChange={(kind) =>
              void save({
                dailyGoal: { kind, value: convertGoal(kind, goal.value, prefs.focusMin) }
              })
            }
          />
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={limits.min}
              max={limits.max}
              value={goal.value}
              onChange={(e) =>
                setPrefs({ ...prefs, dailyGoal: { ...goal, value: Number(e.target.value) } })
              }
              onBlur={(e) =>
                void save({ dailyGoal: { kind: goal.kind, value: Number(e.target.value) } })
              }
              className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-brand"
            />
            <span className="text-xs text-slate-400">
              {goal.kind === 'rounds' ? '轮' : '分钟'}
              {goal.kind === 'minutes' && goal.value >= 60 && (
                <span className="ml-1 text-slate-300">（{focusLabel(goal.value)}）</span>
              )}
            </span>
          </div>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          {goal.kind === 'rounds'
            ? '按完成的专注轮数算。切到「按时长」会自动换算成大致等价的分钟数。'
            : '按完成的专注分钟数算，一轮长短不一时更公平。'}
        </p>
      </div>

      <label className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
        <span>
          <span className="block text-sm">自动开始下一轮</span>
          <span className="block text-xs text-slate-400">
            一轮结束后不等确认，直接进入休息或下一轮专注
          </span>
        </span>
        <Toggle
          checked={prefs.autoStart}
          onChange={(v) => void save({ autoStart: v })}
          ariaLabel="自动开始下一轮"
        />
      </label>
    </Section>
  )
}
