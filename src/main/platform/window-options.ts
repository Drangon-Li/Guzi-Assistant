import { nativeTheme, type BrowserWindowConstructorOptions } from 'electron'

export function floatingPanelOptions(): BrowserWindowConstructorOptions {
  return process.platform === 'darwin'
    ? { vibrancy: 'menu', visualEffectState: 'active', backgroundColor: '#00000000', roundedCorners: true }
    : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#202126' : '#ffffff' }
}
