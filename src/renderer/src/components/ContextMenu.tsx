import { useLayoutEffect, useRef, useState } from 'react'

/** 右键菜单条目：item 可带勾选态/危险色/点击后保持打开（两步确认用） */
export type MenuEntry =
  | {
      type?: 'item'
      label: string
      danger?: boolean
      checked?: boolean
      disabled?: boolean
      /** 点击后不关菜单（如「删除 → 确认删除」的两步确认） */
      keepOpen?: boolean
      onClick: () => void
    }
  | { type: 'separator' }
  | { type: 'header'; label: string }

interface Props {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}

/** 应用内自绘右键菜单：透明遮罩挡外部点击，位置自动夹进视口。 */
export default function ContextMenu({ x, y, entries, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { innerWidth, innerHeight } = window
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, innerHeight - r.height - 8))
    })
  }, [x, y, entries.length])

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={ref}
        className="animate-menu absolute min-w-44 rounded-xl border border-slate-200 bg-surface py-1.5 shadow-xl"
        style={{
          left: pos.x,
          top: pos.y,
          // 从光标所在的那一角展开。夹位把菜单推离光标时（pos < 原始坐标）origin 翻到对侧，
          // 否则贴着屏幕边缘弹出的菜单会从背离光标的角展开，看着像凭空冒出来。
          transformOrigin: `${pos.x < x ? 'right' : 'left'} ${pos.y < y ? 'bottom' : 'top'}`
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {entries.map((entry, i) => {
          if (entry.type === 'separator')
            return <div key={i} className="mx-2 my-1 h-px bg-slate-100" />
          if (entry.type === 'header')
            return (
              <div key={i} className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium text-slate-400">
                {entry.label}
              </div>
            )
          return (
            <button
              key={i}
              disabled={entry.disabled}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs disabled:opacity-40 ${
                entry.danger
                  ? 'text-red-500 hover:bg-red-50'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
              onClick={() => {
                entry.onClick()
                if (!entry.keepOpen) onClose()
              }}
            >
              <span className="w-3 shrink-0 text-brand">{entry.checked ? '✓' : ''}</span>
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
