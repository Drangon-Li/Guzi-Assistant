import { globalShortcut } from 'electron'

let current: string | null = null
let lastTrigger = 0
let onTrigger: () => void = () => {}

const DEBOUNCE_MS = 800

function fire(): void {
  const now = Date.now()
  if (now - lastTrigger < DEBOUNCE_MS) return
  lastTrigger = now
  onTrigger()
}

/** 注册新快捷键；失败时恢复旧键并返回 false（组合无效或被其他应用占用） */
export function setHotkey(accelerator: string): boolean {
  if (current) globalShortcut.unregister(current)
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, fire)
  } catch {
    ok = false
  }
  if (ok) {
    current = accelerator
  } else if (current) {
    globalShortcut.register(current, fire)
  }
  return ok
}

export function initHotkey(initial: string, trigger: () => void): void {
  onTrigger = trigger
  if (!setHotkey(initial)) {
    console.warn(`[hotkey] ${initial} 注册失败，可能被其他应用占用`)
  }
}

export function stopHotkey(): void {
  globalShortcut.unregisterAll()
}
