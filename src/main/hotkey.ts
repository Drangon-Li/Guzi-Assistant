import { globalShortcut, systemPreferences } from 'electron'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import type { HotkeyMode } from '@shared/types'

let mode: HotkeyMode | null = null
let listenerStarted = false
let spaceHeld = false
let spaceDownAt = 0
let lastTrigger = 0
let onTrigger: () => void = () => {}

const HOLD_MS = 150 // 按住 Space 超过该时长再按 C 才触发，减少正常打字误触（文档 3.2）
const DEBOUNCE_MS = 800

function fire(): void {
  const now = Date.now()
  if (now - lastTrigger < DEBOUNCE_MS) return
  lastTrigger = now
  onTrigger()
}

let handlersAttached = false

function startListener(): void {
  if (listenerStarted) return
  attachHandlers()
  try {
    uIOhook.start()
    listenerStarted = true
  } catch (e) {
    // 未授予辅助功能权限时 start 会抛错；授权后通过 ensureHotkey 重试
    console.warn('[hotkey] 全局监听启动失败：', e instanceof Error ? e.message : e)
  }
}

function attachHandlers(): void {
  if (handlersAttached) return
  handlersAttached = true
  uIOhook.on('keydown', (e) => {
    if (mode !== 'space_c') return
    if (e.keycode === UiohookKey.Space) {
      if (!spaceHeld) {
        spaceHeld = true
        spaceDownAt = Date.now()
      }
    } else if (e.keycode === UiohookKey.C && spaceHeld && Date.now() - spaceDownAt >= HOLD_MS) {
      fire()
    }
  })
  uIOhook.on('keyup', (e) => {
    if (e.keycode === UiohookKey.Space) spaceHeld = false
  })
}

export function setHotkeyMode(next: HotkeyMode): void {
  if (mode === 'alt_space') globalShortcut.unregister('Alt+Space')
  mode = next
  if (next === 'alt_space') {
    globalShortcut.register('Alt+Space', fire)
  } else {
    // 全局键盘监听需要 macOS 辅助功能权限，传 true 触发系统授权弹窗
    if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true)
    startListener()
  }
}

export function initHotkey(initial: HotkeyMode, trigger: () => void): void {
  onTrigger = trigger
  setHotkeyMode(initial)
}

export function stopHotkey(): void {
  if (listenerStarted) uIOhook.stop()
  globalShortcut.unregisterAll()
}

/** 用户授予辅助功能权限后补启全局监听（设置页刷新状态时调用） */
export function ensureHotkey(): void {
  if (mode === 'space_c' && !listenerStarted && accessibilityGranted()) startListener()
}

export function accessibilityGranted(): boolean {
  return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false)
}
