import { app, Menu, nativeImage, Tray } from 'electron'
import { initDb, getSettings } from './db'
import { registerIpc, triggerClipboardCapture } from './ipc'
import { initHotkey, stopHotkey } from './hotkey'
import { initDropbox } from './dropbox'
import { ensureFeishu } from './feishu'
import { applyScreenSenseSettings } from './screenwatch'
import { submitExternalFiles } from './capture'
import { appState, createMainWindow, focusMain } from './windows'
import { startDailyBrief, stopDailyBrief } from './dailybrief-scheduler'

let tray: Tray | null = null

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('EShell')
  tray.setToolTip('纸壳助手（可把文件拖到这里提交解析）')
  // macOS：文件拖到菜单栏图标上直接提交解析
  tray.on('drop-files', (_e, files) => {
    if (files.length) void submitExternalFiles(files)
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 纸壳助手', click: () => focusMain() },
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
    initDropbox()
    ensureFeishu()
    applyScreenSenseSettings()
    startDailyBrief()
  })

  app.on('activate', () => focusMain())
  app.on('before-quit', () => {
    appState.quitting = true
  })
  app.on('will-quit', () => {
    stopHotkey()
    stopDailyBrief()
  })
  // 常驻托盘：所有窗口关闭后不退出
  app.on('window-all-closed', () => {})
}
