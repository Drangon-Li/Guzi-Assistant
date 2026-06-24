import { useEffect, useState } from 'react'
import { api } from '../api'

const SCALE_OPTIONS = [
  { label: '极小', value: 0.5 },
  { label: '小', value: 0.65 },
  { label: '中', value: 0.8 },
  { label: '大', value: 1 },
  { label: '超大', value: 1.25 }
]

/** 设置页「桌宠」分区：显隐、大小、暂停、重置位置。 */
export default function PetSettings(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [scale, setScale] = useState(1)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    void api.petGetPrefs().then((p) => {
      setEnabled(p.enabled)
      setScale(p.scale)
      setPaused(p.paused)
    })
  }, [])

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex items-center justify-between gap-4">
        <span className="text-slate-500">显示桌宠</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const v = e.target.checked
            setEnabled(v)
            void api.petSetEnabled(v)
          }}
        />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="text-slate-500">大小</span>
        <select
          value={scale}
          onChange={(e) => {
            const v = Number(e.target.value)
            setScale(v)
            void api.petSetScale(v)
          }}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
        >
          {SCALE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="text-slate-500">暂停（变暗冻结）</span>
        <input
          type="checkbox"
          checked={paused}
          onChange={(e) => {
            const v = e.target.checked
            setPaused(v)
            void api.petSetPaused(v)
          }}
        />
      </label>
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-500">位置</span>
        <button
          onClick={() => void api.petResetPosition()}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
        >
          重置到右下角
        </button>
      </div>
      <p className="text-xs leading-5 text-slate-400">桌宠替代了原右下角的悬浮助手——点它即可打开对话。</p>
    </div>
  )
}
