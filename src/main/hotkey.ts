import { globalShortcut } from 'electron'
import type { HotkeyMode } from '@shared/types'

const ACCELERATORS: Record<HotkeyMode, string> = {
  alt_c: 'Alt+C',
  alt_space: 'Alt+Space',
  cmd_shift_c: 'CommandOrControl+Shift+C'
}

let current: HotkeyMode | null = null
let lastTrigger = 0
let onTrigger: () => void = () => {}

const DEBOUNCE_MS = 800

function fire(): void {
  const now = Date.now()
  if (now - lastTrigger < DEBOUNCE_MS) return
  lastTrigger = now
  onTrigger()
}

/** 切换全局快捷键；返回 false 表示注册失败（被其他应用占用） */
export function setHotkeyMode(next: HotkeyMode): boolean {
  if (current) globalShortcut.unregister(ACCELERATORS[current])
  current = next
  return globalShortcut.register(ACCELERATORS[next], fire)
}

export function initHotkey(initial: HotkeyMode, trigger: () => void): void {
  onTrigger = trigger
  if (!setHotkeyMode(initial)) {
    console.warn(`[hotkey] ${ACCELERATORS[initial]} 注册失败，可能被其他应用占用`)
  }
}

export function stopHotkey(): void {
  globalShortcut.unregisterAll()
}
