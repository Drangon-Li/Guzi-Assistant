import { useEffect, useRef, useState } from 'react'

interface Props {
  panelClass: string
  onClose: () => void
  /** children 拿到带退出动画的 close，用它代替直接调 onClose */
  children: (close: () => void) => React.ReactNode
}

/** 统一的弹窗壳：遮罩淡入淡出 + 面板缩放进出，Esc / 点遮罩关闭 */
export default function Modal({ panelClass, onClose, children }: Props): React.JSX.Element {
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  const close = (): void => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    window.setTimeout(onClose, 160)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-[#11152030] ${
        closing ? 'animate-overlay-out' : 'animate-overlay-in'
      }`}
      onClick={close}
    >
      <div
        className={`${panelClass} ${closing ? 'animate-modal-out' : 'animate-modal-in'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children(close)}
      </div>
    </div>
  )
}
