import { useState } from 'react'
import { dayKey } from '@shared/work-report'

/**
 * 小日历跳转（分析页）：按钮弹出月历，点任意一天直达；有数据的日子带品牌色小点，
 * 未来日期禁用，「今天」一键回跳。零依赖手绘，配色全走现有 token。
 */

interface Props {
  day: string
  onChange: (day: string) => void
  /** 有活跃数据的日子（YYYY-MM-DD），渲染小圆点提示"这天有内容可看" */
  activeDays: Set<string>
}

const WEEK_HEADS = ['一', '二', '三', '四', '五', '六', '日']

export default function MiniCalendar({ day, onChange, activeDays }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => day.slice(0, 7)) // YYYY-MM

  const today = dayKey(new Date())

  const shiftMonth = (d: number): void => {
    const [y, m] = month.split('-').map(Number)
    const next = new Date(y, m - 1 + d, 1)
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`)
  }

  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const leadBlanks = (new Date(y, m - 1, 1).getDay() + 6) % 7 // 周一开头

  const pick = (d: number): void => {
    const key = `${month}-${String(d).padStart(2, '0')}`
    if (key > today) return
    onChange(key)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        onClick={() => {
          setMonth(day.slice(0, 7))
          setOpen(!open)
        }}
      >
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
          <path d="M4 10.5h16" />
          <path d="M8.5 3.5v3" />
          <path d="M15.5 3.5v3" />
        </svg>
        选日期
      </button>

      {open && (
        <>
          {/* 点外部关闭 */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-30 mt-2 w-64 rounded-xl border border-slate-200 bg-surface p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <button className="rounded-md px-2 py-0.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => shiftMonth(-1)}>
                ‹
              </button>
              <span className="text-sm font-medium">
                {y} 年 {m} 月
              </span>
              <button className="rounded-md px-2 py-0.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => shiftMonth(1)}>
                ›
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-slate-400">
              {WEEK_HEADS.map((w) => (
                <span key={w} className="py-1">
                  {w}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {Array.from({ length: leadBlanks }).map((_, i) => (
                <span key={`b${i}`} />
              ))}
              {Array.from({ length: daysInMonth }, (_, i) => {
                const d = i + 1
                const key = `${month}-${String(d).padStart(2, '0')}`
                const future = key > today
                const selected = key === day
                return (
                  <button
                    key={d}
                    disabled={future}
                    onClick={() => pick(d)}
                    className={`relative rounded-md py-1 text-center text-xs transition-colors ${
                      selected
                        ? 'bg-brand font-medium text-white'
                        : future
                          ? 'text-slate-300'
                          : 'text-slate-600 hover:bg-brand-soft'
                    } ${key === today && !selected ? 'font-semibold text-brand' : ''}`}
                  >
                    {d}
                    {activeDays.has(key) && !selected && (
                      <span className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-brand/70" />
                    )}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex justify-end">
              <button
                className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                onClick={() => {
                  onChange(today)
                  setOpen(false)
                }}
              >
                回到今天
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
