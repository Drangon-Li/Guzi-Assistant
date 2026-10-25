export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

export function desktopPlatform(value: string): DesktopPlatform {
  return value === 'darwin' || value === 'win32' ? value : 'linux'
}

export function formatAccelerator(acc: string, platform: DesktopPlatform): string {
  const symbols: Record<string, string> = platform === 'darwin'
    ? { Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Super: '⌘', Meta: '⌘' }
    : { Command: 'Win', Cmd: 'Win', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift', Super: 'Win', Meta: 'Win' }
  return acc.split('+').map((key) => symbols[key] ?? key).join(platform === 'darwin' ? ' ' : '+')
}

export function permissionLabel(status: string): string {
  if (status === 'granted') return '已授权'
  if (status === 'denied' || status === 'restricted') return '已拒绝或受系统限制'
  if (status === 'not-determined') return '尚未请求'
  if (status === 'unsupported') return '系统不支持查询'
  return '无法预先确认，请以实际使用结果为准'
}
