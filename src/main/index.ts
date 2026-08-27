import { app, Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions } from 'electron'
import { initDb, getSettings } from './db'
import { registerIpc, triggerClipboardCapture, triggerScreenshotCapture } from './ipc'
import { initHotkey, initNamedHotkey, initScreenshotHotkey, stopHotkey } from './hotkey'
import { initDropbox } from './dropbox'
import { upgradeQuickActionIfNeeded } from './quickaction'
import { ensureFeishu } from './feishu'
import {
  applyScreenSenseSettings,
  setTrayRefresh,
  setWatchPaused,
  isWatchActive,
  isWatchPaused,
  stopWatch
} from './screenwatch'
import { shutdownHistoryStore } from './history/service.ts'
import { submitExternalFiles } from './capture'
import {
  appState,
  createMainWindow,
  focusMain,
  openDebugWindow,
  repositionPreviewNearPet,
  toggleMainWindow
} from './windows'
import { createPetWindow, setOnPetMoved } from './pet/pet-window'
import { togglePetChat, createPetChatWindow } from './pet/pet-chat-window'
import {
  showPet,
  hidePet,
  isPetVisible,
  getPetPausedState,
  setPetPausedState,
  setPetListening,
  togglePetListening
} from './pet/controller'
import { createQuickBar, toggleQuickBar } from './quickbar'
import { applyMcpSettings, stopMcpServer } from './mcp-server'
import { scheduleStartupUpdateCheck } from './updater'
import { startDailyBrief, stopDailyBrief } from './dailybrief-scheduler'
import { startWellnessReminder, stopWellnessReminder } from './wellness-reminder'
import { applyTaskReminderSchedule, stopTaskReminder } from './task-reminder'
import { applyClipWatchSettings, stopClipWatch } from './clipwatch'
import { installAppMenu } from './app-menu'
import { cpSync, existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import trayIcon from '../../resources/trayTemplate.png?asset'
import trayIcon2x from '../../resources/trayTemplate@2x.png?asset'

const userDataOverride = process.env.GUZI_ASSISTANT_USER_DATA_DIR
if (userDataOverride) {
  app.setPath('userData', userDataOverride)
} else {
  // productName 对外改为中文，但沿用旧目录，避免丢失数据库、权限关联的本地状态和快捷操作 dropbox。
  app.setPath('userData', join(app.getPath('appData'), 'GuziAssistant'))
}

// productName 改名会切换 userData；按新到旧顺序迁移历史目录，只复制不删以保留回滚路径。
function migrateLegacyUserData(): void {
  const dir = app.getPath('userData')
  if (existsSync(join(dir, 'eshell.db'))) return
  for (const name of ['Gooz', 'EShell', '谷子助手']) {
    const legacy = join(dirname(dir), name)
    if (!existsSync(join(legacy, 'eshell.db'))) continue
    try {
      cpSync(legacy, dir, { recursive: true, force: false })
    } catch (e) {
      console.error(`[migrate] 旧数据目录 ${name} 迁移失败：`, e)
    }
    return
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
    // 实测进程会以配件(UIElement)策略登记——不占菜单栏、无 Dock 图标，应用菜单永远显示不出来。
    // setActivationPolicy 单独调用翻不过来，需 dock.show() 由系统异步完成常规化
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular')
      void app.dock?.show()
    }
    initDb()
    nativeTheme.themeSource = getSettings().theme // 应用主题设置：驱动渲染层 prefers-color-scheme + 桌宠/窗口深浅色
    installAppMenu()
    registerIpc()
    // 开机自启拉起的这次不弹主窗：桌宠和托盘照常在，用户要用时自己叫出来
    createMainWindow(!app.getLoginItemSettings().wasOpenedAtLogin)
    createPetWindow({
      onClick: () => togglePetChat(),
      onDblClick: () => toggleMainWindow(),
      // 长按桌宠 → 聆听特效 + 「我正在听～」气泡（语音助手第一步；STT/对话后续接入这两个回调）
      onLongPressStart: () => setPetListening(true),
      onLongPressEnd: () => setPetListening(false)
    })
    setOnPetMoved(repositionPreviewNearPet) // 拖桌宠时贴在旁边的通知卡跟着走
    createPetChatWindow() // 预创建桌宠对话窗口（隐藏），点击/拖文件即时可用
    createQuickBar() // 预创建快捷提问框（隐藏），按快捷键秒开
    createTray()
    setTrayRefresh(buildTrayMenu) // 监控启停/暂停时刷新托盘菜单
    initHotkey(getSettings().hotkey, triggerClipboardCapture)
    initScreenshotHotkey(getSettings().screenshotHotkey, triggerScreenshotCapture)
    initNamedHotkey('mainWindow', getSettings().mainWindowHotkey, toggleMainWindow)
    initNamedHotkey('petVoice', getSettings().petVoiceHotkey, togglePetListening)
    initNamedHotkey('quickAsk', getSettings().quickAskHotkey, toggleQuickBar)
    initDropbox()
    upgradeQuickActionIfNeeded()
    ensureFeishu()
    applyScreenSenseSettings()
    applyMcpSettings() // 对外 MCP 服务（默认关，设置页开启）
    startDailyBrief()
    startWellnessReminder()
    applyTaskReminderSchedule() // 设置里关掉时连提醒窗都不建
    applyClipWatchSettings()
    if (app.isPackaged) scheduleStartupUpdateCheck() // dev 实例天天重启，别拿开发机刷清单
  })

  // macOS 惯例：仅在没有可见窗口时（如点 Dock 图标重开）才显示主窗；
  // 否则点悬浮建议卡使 app 激活会偶发把主窗一并拉出（见 focusMain 诊断）
  app.on('activate', (_e, hasVisibleWindows) => {
    if (!hasVisibleWindows) focusMain()
  })
  app.on('before-quit', () => {
    appState.quitting = true
  })
  let historyShutdownStarted = false
  app.on('will-quit', (event) => {
    stopHotkey()
    stopWatch()
    stopDailyBrief()
    stopWellnessReminder()
    stopTaskReminder()
    stopClipWatch()
    stopMcpServer()
    if (historyShutdownStarted) return
    historyShutdownStarted = true
    event.preventDefault()
    void shutdownHistoryStore()
      .catch((error) => console.error('[history] shutdown failed:', error))
      .finally(() => app.quit())
  })
  // 常驻托盘：所有窗口关闭后不退出
  app.on('window-all-closed', () => {})
}
