import { app, dialog, Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions } from 'electron'
import { applyVoiceSettings, recoverStaleVoiceSession } from './voicenotes/service'
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
import { cpSync, existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { dirname, extname, join } from 'path'
import { isSafeDropPath } from '@shared/safe-path'
import { explorerFilesFromArgv, windowsSecondInstanceArgv, EXPLORER_EXTENSIONS, EXPLORER_FILE_FLAG } from './platform/windows-integration'
import windowsTrayIcon from '../../resources/trayWindows.png?asset'
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
  if (userDataOverride) return
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
      label: isPetVisible() ? '隐藏悬浮球' : '显示悬浮球',
      click: () => {
        if (isPetVisible()) hidePet()
        else showPet()
        buildTrayMenu()
      }
    },
    {
      label: getPetPausedState() ? '恢复悬浮球' : '暂停悬浮球',
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
  const icon = nativeImage.createFromPath(process.platform === 'darwin' ? trayIcon : windowsTrayIcon)
  if (process.platform === 'darwin') {
    icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayIcon2x) })
    icon.setTemplateImage(true) // macOS 根据菜单栏深浅自动着色
  }
  tray = new Tray(icon)
  tray.setToolTip(process.platform === 'darwin' ? '谷子助手（可把文件拖到这里提交解析）' : '谷子助手')
  if (process.platform !== 'darwin') tray.on('click', () => focusMain())
  // macOS：文件拖到菜单栏图标上直接提交解析
  tray.on('drop-files', (_e, files) => {
    if (files.length) void submitExternalFiles(files)
  })
  buildTrayMenu()
}

async function handleExternalFileArgs(argv: string[]): Promise<boolean> {
  if (process.platform !== 'win32' || !argv.includes(EXPLORER_FILE_FLAG)) return false
  const paths = explorerFilesFromArgv(argv)
  const valid = paths.filter((file) => {
    try {
      return isSafeDropPath(file) && isSafeDropPath(realpathSync(file)) &&
        EXPLORER_EXTENSIONS.includes(extname(file).toLowerCase()) && statSync(file).isFile()
    } catch { return false }
  })
  if (valid.length !== paths.length || !valid.length) {
    await dialog.showMessageBox({ type: 'warning', title: '无法提交文件', message: '请选择用户目录中的受支持文件。', detail: '支持图片、PDF、Word 文档和文本文件；系统目录、应用数据和隐藏文件不会被提交。' })
    return true
  }
  await submitExternalFiles(valid)
  return true
}

migrateLegacyUserData()

// Electron may reorder or inject second-instance argv; preserve the Windows Explorer command verbatim.
const hasSingleInstanceLock = process.platform === 'win32'
  ? app.requestSingleInstanceLock({ argv: process.argv })
  : app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData: unknown) => {
    const fileArgs = process.platform === 'win32' ? windowsSecondInstanceArgv(additionalData) : argv
    void app.whenReady().then(async () => {
      if (!await handleExternalFileArgs(fileArgs)) focusMain()
    })
  })

  app.whenReady().then(() => {
    // 实测进程会以配件(UIElement)策略登记——不占菜单栏、无 Dock 图标，应用菜单永远显示不出来。
    // setActivationPolicy 单独调用翻不过来，需 dock.show() 由系统异步完成常规化
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular')
      void app.dock?.show()
    }
    if (process.platform === 'win32') app.setAppUserModelId('cn.shilong.gooz')
    initDb()
    nativeTheme.themeSource = getSettings().theme // 应用主题设置：驱动渲染层 prefers-color-scheme + 桌宠/窗口深浅色
    installAppMenu()
    registerIpc()
    // 开机自启拉起的这次不弹主窗：桌宠和托盘照常在，用户要用时自己叫出来
    const openedAtLogin = process.platform === 'win32' ? process.argv.includes('--hidden') : app.getLoginItemSettings().wasOpenedAtLogin
    const externalFileStartup = process.platform === 'win32' && process.argv.includes(EXPLORER_FILE_FLAG)
    createMainWindow(!openedAtLogin && !externalFileStartup)
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
    void handleExternalFileArgs(process.argv)
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
    // 语音纪要：上次强退可能留下没收尾的录制会话，先收干净再起监听
    recoverStaleVoiceSession()
    applyVoiceSettings()
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
