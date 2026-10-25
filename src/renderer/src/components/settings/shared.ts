import { isMac } from '../../platform'
// 设置页的快捷键工具：录制用的键位映射与 accelerator 转换，父组件与「快捷键」分区共用。

export type HotkeyField =
  | 'hotkey'
  | 'screenshotHotkey'
  | 'screenSenseHotkey'
  | 'mainWindowHotkey'
  | 'petVoiceHotkey'
  | 'quickAskHotkey'

// 快捷键设置行：新增全局快捷键时在这里登记一行即可（录制/保存/展示逻辑通用）
export const HOTKEY_ROWS: { key: HotkeyField; label: string }[] = [
  { key: 'hotkey', label: '提交剪切板' },
  { key: 'screenshotHotkey', label: '提交屏幕截图' },
  { key: 'screenSenseHotkey', label: '整屏感知扫描' },
  { key: 'mainWindowHotkey', label: '打开主界面' },
  { key: 'petVoiceHotkey', label: '悬浮球说话模式' },
  { key: 'quickAskHotkey', label: '快捷提问框' }
]

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Enter: 'Enter',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

/** KeyboardEvent → Electron accelerator；组合不完整时返回 null（继续等待按键） */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let key: string | null = null
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3)
  else if (/^Digit\d$/.test(c)) key = c.slice(5)
  else if (/^F\d{1,2}$/.test(c)) key = c
  else if (c in CODE_KEYS) key = CODE_KEYS[c]
  if (!key) return null
  // 普通键必须带修饰键，否则会全局吞掉日常输入；F1-F12 例外
  if (!mods.length && !/^F\d/.test(key)) return null
  return [...mods, key].join('+')
}
