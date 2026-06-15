import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { initDb } from './db'
import { registerIpc, triggerClipboardCapture } from './ipc'
import { initDropbox } from './dropbox'
import { ensureFeishu } from './feishu'
import {
  applyScreenSenseSettings,
  setTrayRefresh,
  setWatchPaused,
  isWatchActive,
  isWatchPaused
} from './screenwatch'
import { submitExternalFiles } from './capture'
import { appState, createMainWindow, focusMain } from './windows'
import { startDailyBrief, stopDailyBrief } from './dailybrief-scheduler'

let tray: Tray | null = null

/** 重建托盘菜单：持续监控开启时多一个「暂停/恢复屏幕监控」项（由 setTrayRefresh 在状态变化时回调） */
function buildTrayMenu(): void {
  if (!tray) return
  const items: MenuItemConstructorOptions[] = [
    { label: '打开 纸壳助手', click: () => focusMain() },
    { label: '提交剪切板内容', click: () => triggerClipboardCapture() }
  ]
  if (isWatchActive()) {
    items.push(
      { type: 'separator' },
      {
        label: isWatchPaused() ? '恢复屏幕监控' : '暂停屏幕监控',
        click: () => setWatchPaused(!isWatchPaused())
      }
    )
  }
  items.push(
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        appState.quitting = true
        app.quit()
      }
    }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('EShell')
  tray.setToolTip('纸壳助手（可把文件拖到这里提交解析）')
  // macOS：文件拖到菜单栏图标上直接提交解析
  tray.on('drop-files', (_e, files) => {
    if (files.length) void submitExternalFiles(files)
  })
  buildTrayMenu()
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
    setTrayRefresh(buildTrayMenu) // 监控启停/暂停时刷新托盘菜单
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
    stopDailyBrief()
  })
  // 常驻托盘：所有窗口关闭后不退出
  app.on('window-all-closed', () => {})
}
