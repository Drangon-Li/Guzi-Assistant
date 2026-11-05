import type { BrowserWindow } from 'electron'

const FRAME_MS = 16
/** 每个窗口同一时刻只跑一个渐变：新的渐变会接管旧的（比如淡出途中又被唤起） */
const running = new WeakMap<BrowserWindow, ReturnType<typeof setInterval>>()

/**
 * 窗口透明度渐变。磨砂和原生阴影只能整窗淡入淡出，CSS 动不了这两层——
 * 预览卡、快捷提问这类浮窗都靠它。
 */
export function fadeWindow(win: BrowserWindow, from: number, to: number, durationMs: number, done?: () => void): void {
  const stop = (): void => {
    clearInterval(running.get(win))
    running.delete(win)
  }
  stop()
  const steps = Math.max(1, Math.round(durationMs / FRAME_MS))
  let i = 0
  win.setOpacity(from)
  running.set(win, setInterval(() => {
    i++
    if (win.isDestroyed()) return stop()
    win.setOpacity(from + ((to - from) * i) / steps)
    if (i >= steps) {
      stop()
      done?.()
    }
  }, FRAME_MS))
}
