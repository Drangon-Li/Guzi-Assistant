// 通用小组件：卡片区块 / 分段切换 / 日期翻页 / 横向占比条。
// 各页面重复出现的样式模式统一收敛于此，改样式只动这一处。
import type { ReactNode } from 'react'
import { dayKey } from '@shared/work-report'

/** Compact accessible switch used for binary settings. */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  ariaLabel
}: {
  checked: boolean
  onChange: (next: boolean) => void | Promise<void>
  disabled?: boolean
  ariaLabel: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => void onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-brand' : 'bg-slate-300'
      }`}
    >
      {/* 轨道 36×20、滑块 16×16、左右各留 2px：选中态 translate-x-4 使两侧边距对称（原 translate-x-5 会让滑块溢出右缘 2px） */}
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

/** 卡片区块：圆角边框容器；页头可带说明文字与右侧操作区。 */
export function Section({
  title,
  desc,
  actions,
  children
}: {
  title: string
  desc?: string
  actions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
      <div className={`flex items-center justify-between ${desc ? 'mb-1' : 'mb-3'}`}>
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {desc && <p className="mb-3 text-xs text-slate-400">{desc}</p>}
      {children}
    </section>
  )
}

/** 分段切换 pill 组（列表/时间轴、今日/本周…）。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="flex w-fit rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`rounded-md px-3 py-1 ${
            value === key
              ? 'bg-surface text-slate-900 font-medium shadow-sm'
              : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** 日期翻页：← 今天 MM-DD →；右界封在今天。 */
export function DayNav({ day, onChange }: { day: string; onChange: (d: string) => void }): React.JSX.Element {
  const today = dayKey(new Date())
  const shift = (delta: number): void => {
    const d = new Date(`${day}T12:00`)
    d.setDate(d.getDate() + delta)
    const next = dayKey(d)
    if (next <= today) onChange(next)
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-500 hover:bg-slate-50"
        onClick={() => shift(-1)}
      >
        ←
      </button>
      <span className="w-28 text-center font-medium">{day === today ? `今天 ${day.slice(5)}` : day}</span>
      <button
        className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
        onClick={() => shift(1)}
        disabled={day >= today}
      >
        →
      </button>
    </div>
  )
}

/** 横向占比条一行：标签 + 品牌色条 + 右侧数值；可带悬停删除。放在 <ul> 内使用。 */
export function BarRow({
  label,
  value,
  max,
  valueLabel,
  detail,
  onDelete
}: {
  label: string
  value: number
  max: number
  valueLabel: string
  detail?: string
  onDelete?: () => void
}): React.JSX.Element {
  return (
    <li className="group flex items-center gap-3 text-sm">
      <span className="w-36 shrink-0 truncate text-slate-600">{label}</span>
      <div className="h-2 min-w-0 flex-1 rounded-full bg-slate-100">
        <div
          className="h-2 rounded-full bg-brand"
          style={{ width: `${Math.max(2, Math.round((value / Math.max(max, 1)) * 100))}%` }}
        />
      </div>
      <span className="w-28 shrink-0 text-right text-xs text-slate-400">
        <span className="block truncate" title={valueLabel}>{valueLabel}</span>
        {detail && <span className="block truncate text-[10px] text-slate-300" title={detail}>{detail}</span>}
      </span>
      {onDelete && (
        <button
          className="invisible shrink-0 px-1 text-xs text-slate-400 group-hover:visible hover:text-red-500"
          onClick={onDelete}
        >
          删除
        </button>
      )}
    </li>
  )
}
