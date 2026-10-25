import type { DesktopPlatform } from '../../shared/platform'

export const platform: DesktopPlatform = typeof window === 'undefined' ? 'darwin' : window.guziAssistant.platform
export const isMac = platform === 'darwin'
export const primaryModifier = isMac ? '⌘' : 'Ctrl'
