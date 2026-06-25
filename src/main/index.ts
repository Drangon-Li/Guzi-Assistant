import { app, Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions } from 'electron'
import { initDb, getSettings } from './db'
import { registerIpc, triggerClipboardCapture } from './ipc'
import { initHotkey, stopHotkey } from './hotkey'
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
import { appState, createMainWindow, focusMain, openDebugWindow, toggleMainWindow } from './windows'
import { createPetWindow } from './pet/pet-window'
import { togglePetChat, createPetChatWindow } from './pet/pet-chat-window'
import {
  showPet,
  hidePet,
  isPetVisible,
  getPetPausedState,
  setPetPausedState
} from './pet/controller'
import { startDailyBrief, stopDailyBrief } from './dailybrief-scheduler'
import { readFileSync } from 'fs'
import trayIcon from '../../resources/trayTemplate.png?asset'
import trayIcon2x from '../../resources/trayTemplate@2x.png?asset'

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
      label: isPetVisible() ? '隐藏桌宠' : '显示桌宠',
      click: () => {
        if (isPetVisible()) hidePet()
        else showPet()
        buildTrayMenu()
      }
    },
    {
      label: getPetPausedState() ? '恢复桌宠' : '暂停桌宠',
      click: () => {
        setPetPausedState(!getPetPausedState())
        buildTrayMenu()
      }
    }
  )
  if (!app.isPackaged) {
    items.push({ type: 'separator' }, { label: '调试监控面板', click: () => openDebugWindow() })
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
  const icon = nativeImage.createFromPath(trayIcon)
  icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayIcon2x) })
  icon.setTemplateImage(true) // 单色剪影，由 macOS 按菜单栏明暗自动着色（深色栏白/浅色栏黑）
  tray = new Tray(icon)
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
    nativeTheme.themeSource = getSettings().theme // 应用主题设置：驱动渲染层 prefers-color-scheme + 桌宠/窗口深浅色
    registerIpc()
    createMainWindow()
    createPetWindow({
      onClick: () => togglePetChat(),
      onDblClick: () => toggleMainWindow()
    })
    createPetChatWindow() // 预创建桌宠对话窗口（隐藏），点击/拖文件即时可用
    createTray()
    setTrayRefresh(buildTrayMenu) // 监控启停/暂停时刷新托盘菜单
    initHotkey(getSettings().hotkey, triggerClipboardCapture)
    initDropbox()
    ensureFeishu()
    applyScreenSenseSettings()
    startDailyBrief()
  })

  // macOS 惯例：仅在没有可见窗口时（如点 Dock 图标重开）才显示主窗；
  // 否则点悬浮建议卡使 app 激活会偶发把主窗一并拉出（见 focusMain 诊断）
  app.on('activate', (_e, hasVisibleWindows) => {
    if (!hasVisibleWindows) focusMain()
  })
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
