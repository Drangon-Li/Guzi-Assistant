// 设置页的「专注」分区：四个时长参数。
import { useEffect, useState } from 'react'
import { DEFAULT_PREFS, type PomodoroPrefs } from '@shared/pomodoro'
import { api } from '../../api'
import { Section } from '../../components/ui'

const FIELDS: { key: keyof PomodoroPrefs; label: string; hint: string; min: number; max: number }[] = [
  { key: 'focusMin', label: '一轮专注', hint: '分钟', min: 1, max: 180 },
  { key: 'shortBreakMin', label: '短休息', hint: '分钟', min: 1, max: 60 },
  { key: 'longBreakMin', label: '长休息', hint: '分钟', min: 1, max: 60 },
  { key: 'roundsBeforeLongBreak', label: '几轮后长休息', hint: '轮', min: 2, max: 12 }
]

export default function PomodoroSettings(): React.JSX.Element {
  const [prefs, setPrefs] = useState<PomodoroPrefs>(DEFAULT_PREFS)

  useEffect(() => {
    void api.plugin<PomodoroPrefs>('pomodoro', 'prefs').then(setPrefs)
  }, [])

  const save = async (key: keyof PomodoroPrefs, raw: string): Promise<void> => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    // 主进程会再夹一次范围，这里直接用回写值，避免本地显示和实际存的不一致
    setPrefs(await api.plugin<PomodoroPrefs>('pomodoro', 'prefs-save', { [key]: value }))
  }

  return (
    <Section title="专注" desc="番茄钟的时长。改完立即生效，正在跑的那一轮不受影响。">
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
                onBlur={(e) => void save(f.key, e.target.value)}
                className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-brand"
              />
              <span className="text-xs text-slate-400">{f.hint}</span>
            </div>
          </label>
        ))}
      </div>
    </Section>
  )
}
