import { app, Menu, nativeImage, Tray } from 'electron'
import { initDb, getSettings } from './db'
import { registerIpc, triggerClipboardCapture } from './ipc'
import { initHotkey, stopHotkey } from './hotkey'
import { appState, createMainWindow, focusMain } from './windows'

let tray: Tray | null = null

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('al1')
  tray.setToolTip('al1 个人事项捕获助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 al1', click: () => focusMain() },
      { label: '提交剪切板内容', click: () => triggerClipboardCapture() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          appState.quitting = true
          app.quit()
        }
      }
    ])
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusMain())

  app.whenReady().then(() => {
    initDb()
    registerIpc()
    createMainWindow()
    createTray()
    initHotkey(getSettings().hotkey, triggerClipboardCapture)
  })

  app.on('activate', () => focusMain())
  app.on('before-quit', () => {
    appState.quitting = true
  })
  app.on('will-quit', () => stopHotkey())
  // 常驻托盘：所有窗口关闭后不退出
  app.on('window-all-closed', () => {})
}
