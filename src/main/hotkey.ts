import { globalShortcut } from 'electron'

const DEBOUNCE_MS = 800

interface Entry {
  accelerator: string | null
  handler: () => void
  last: number
}

const entries = new Map<string, Entry>()

function entryOf(id: string): Entry {
  let e = entries.get(id)
  if (!e) {
    e = { accelerator: null, handler: () => {}, last: 0 }
    entries.set(id, e)
  }
  return e
}

function fireOf(id: string): () => void {
  return () => {
    const e = entries.get(id)
    if (!e) return
    const now = Date.now()
    if (now - e.last < DEBOUNCE_MS) return
    e.last = now
    e.handler()
  }
}

/** 注册/更新具名快捷键；失败时恢复旧键并返回 false（组合无效或被占用） */
function register(id: string, accelerator: string): boolean {
  const e = entryOf(id)
  const prev = e.accelerator
  if (prev) globalShortcut.unregister(prev)
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, fireOf(id))
  } catch {
    ok = false
  }
  if (ok) e.accelerator = accelerator
  else if (prev) globalShortcut.register(prev, fireOf(id))
  return ok
}

function unregister(id: string): void {
  const e = entries.get(id)
  if (e?.accelerator) {
    globalShortcut.unregister(e.accelerator)
    e.accelerator = null
  }
}

// ---- 剪切板捕获快捷键（原有公开 API，签名不变） ----

export function setHotkey(accelerator: string): boolean {
  return register('clipboard', accelerator)
}

export function initHotkey(initial: string, trigger: () => void): void {
  entryOf('clipboard').handler = trigger
  if (!register('clipboard', initial)) {
    console.warn(`[hotkey] ${initial} 注册失败，可能被其他应用占用`)
  }
}

export function stopHotkey(): void {
  globalShortcut.unregisterAll()
}

// ---- 扫描屏幕快捷键 ----

export function initScanHotkey(accelerator: string, trigger: () => void): boolean {
  entryOf('scan').handler = trigger
  const ok = register('scan', accelerator)
  if (!ok) console.warn(`[hotkey] 扫描快捷键 ${accelerator} 注册失败，可能被其他应用占用`)
  return ok
}

export function unregisterScanHotkey(): void {
  unregister('scan')
}

// ---- 提交屏幕截图快捷键 ----

export function setScreenshotHotkey(accelerator: string): boolean {
  return register('screenshot', accelerator)
}

export function initScreenshotHotkey(accelerator: string, trigger: () => void): void {
  entryOf('screenshot').handler = trigger
  if (!register('screenshot', accelerator)) {
    console.warn(`[hotkey] 截图快捷键 ${accelerator} 注册失败，可能被其他应用占用`)
  }
}
