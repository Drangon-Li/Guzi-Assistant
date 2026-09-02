import { useEffect, useState } from 'react'
import { api } from '../api'
import { Toggle } from './ui'

const SCALE_OPTIONS = [
  { label: '迷你', value: 0.3 },
  { label: '小', value: 0.4 },
  { label: '中', value: 0.5 },
  { label: '大', value: 0.65 },
  { label: '特大', value: 0.85 }
]

/** 设置页「桌宠」分区：显隐、大小、暂停、重置位置。 */
export default function PetSettings(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [scale, setScale] = useState(0.3) // 与 state.ts 默认一致，避免拉取前显示错档
  const [paused, setPaused] = useState(false)
  const [bubbles, setBubbles] = useState(true)

  useEffect(() => {
    void api.petGetPrefs().then((p) => {
      setEnabled(p.enabled)
      setScale(p.scale)
      setPaused(p.paused)
      setBubbles(p.bubbles)
    })
  }, [])

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex items-center justify-between gap-4">
        <span className="text-slate-500">显示悬浮球</span>
        <Toggle
          checked={enabled}
          ariaLabel="显示悬浮球"
          onChange={(v) => {
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
        <Toggle
          checked={paused}
          ariaLabel="暂停悬浮球"
          onChange={(v) => {
            setPaused(v)
            void api.petSetPaused(v)
          }}
        />
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="text-slate-500">
          气泡提醒
          <span className="ml-2 text-xs text-slate-400">
            处理中 / 发现日程 / 久坐提醒（连续使用 50 分钟）等主动气泡
          </span>
        </span>
        <Toggle
          checked={bubbles}
          ariaLabel="气泡提醒"
          onChange={(v) => {
            setBubbles(v)
            void api.petSetBubbles(v)
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
      <p className="text-xs leading-5 text-slate-400">悬浮球常驻在桌面上，点它即可打开对话。</p>
    </div>
  )
}
