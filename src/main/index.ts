import { app, Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions } from 'electron'
import { initDb, getSettings } from './db'
import { registerIpc, triggerClipboardCapture, triggerScreenshotCapture } from './ipc'
import { initHotkey, initScreenshotHotkey, stopHotkey } from './hotkey'
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
  setPetPausedState,
  setPetListening
} from './pet/controller'
import { startDailyBrief, stopDailyBrief } from './dailybrief-scheduler'
import { startWellnessReminder, stopWellnessReminder } from './wellness-reminder'
import { installAppMenu } from './app-menu'
import { cpSync, existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import trayIcon from '../../resources/trayTemplate.png?asset'
import trayIcon2x from '../../resources/trayTemplate@2x.png?asset'

// 改名 Gooz 后 userData 目录随 productName 变更；把旧 EShell 目录的数据一次性搬过来（只复制不删，保底可回滚）
function migrateLegacyUserData(): void {
  const dir = app.getPath('userData')
  if (existsSync(join(dir, 'eshell.db'))) return
  const legacy = join(dirname(dir), 'EShell')
  if (!existsSync(join(legacy, 'eshell.db'))) return
  try {
    cpSync(legacy, dir, { recursive: true, force: false })
  } catch (e) {
    console.error('[migrate] 旧数据目录迁移失败：', e)
  }
}

let tray: Tray | null = null

/** 重建托盘菜单：持续监控开启时多一个「暂停/恢复屏幕监控」项（由 setTrayRefresh 在状态变化时回调） */
function buildTrayMenu(): void {
  if (!tray) return
  const items: MenuItemConstructorOptions[] = [
    { label: '打开 谷子助手', click: () => focusMain() },
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
  tray.setToolTip('谷子助手（可把文件拖到这里提交解析）')
  // macOS：文件拖到菜单栏图标上直接提交解析
  tray.on('drop-files', (_e, files) => {
    if (files.length) void submitExternalFiles(files)
  })
  buildTrayMenu()
}

migrateLegacyUserData()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusMain())

  app.whenReady().then(() => {
    initDb()
    nativeTheme.themeSource = getSettings().theme // 应用主题设置：驱动渲染层 prefers-color-scheme + 桌宠/窗口深浅色
    installAppMenu()
    registerIpc()
    createMainWindow()
    createPetWindow({
      onClick: () => togglePetChat(),
      onDblClick: () => toggleMainWindow(),
      // 长按桌宠 → 聆听特效 + 「我正在听～」气泡（语音助手第一步；STT/对话后续接入这两个回调）
      onLongPressStart: () => setPetListening(true),
      onLongPressEnd: () => setPetListening(false)
    })
    createPetChatWindow() // 预创建桌宠对话窗口（隐藏），点击/拖文件即时可用
    createTray()
    setTrayRefresh(buildTrayMenu) // 监控启停/暂停时刷新托盘菜单
    initHotkey(getSettings().hotkey, triggerClipboardCapture)
    initScreenshotHotkey(getSettings().screenshotHotkey, triggerScreenshotCapture)
    initDropbox()
    ensureFeishu()
    applyScreenSenseSettings()
    startDailyBrief()
    startWellnessReminder()
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
    stopWellnessReminder()
  })
  // 常驻托盘：所有窗口关闭后不退出
  app.on('window-all-closed', () => {})
}
