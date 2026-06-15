import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'

export const appState = { quitting: false }

let mainWin: BrowserWindow | null = null
let previewWin: BrowserWindow | null = null

const preload = join(__dirname, '../preload/index.js')

function load(win: BrowserWindow, hash: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) win.loadURL(`${devUrl}#${hash}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

export function createMainWindow(): BrowserWindow {
  if (mainWin && !mainWin.isDestroyed()) return mainWin
  mainWin = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    title: 'EShell',
    show: false,
    // 现代 macOS 风格：隐藏标题栏，红黄绿交通灯浮在侧栏上方（与设计稿一致）
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#ffffff',
    webPreferences: { preload }
  })
  mainWin.on('ready-to-show', () => mainWin?.show())
  // 关窗只隐藏，应用常驻托盘，否则快捷键入口会随窗口一起消失
  mainWin.on('close', (e) => {
    if (!appState.quitting) {
      e.preventDefault()
      mainWin?.hide()
    }
  })
  load(mainWin, '/main')
  return mainWin
}

export function focusMain(route?: string): void {
  const win = createMainWindow()
  win.show()
  win.focus()
  if (route) win.webContents.send('eshell:navigate', route)
}

export function getPreviewWindow(): BrowserWindow {
  if (previewWin && !previewWin.isDestroyed()) return previewWin
  previewWin = new BrowserWindow({
    width: 380,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload }
  })
  previewWin.setAlwaysOnTop(true, 'screen-saver')
  previewWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  load(previewWin, '/preview')
  return previewWin
}

/** 在屏幕右下角弹出预览卡，不抢当前应用焦点 */
export function showPreview(payload: unknown): void {
  const win = getPreviewWindow()
  const { workArea } = screen.getPrimaryDisplay()
  win.setPosition(workArea.x + workArea.width - 396, workArea.y + workArea.height - 276)
  const send = (): void => {
    win.webContents.send('eshell:preview', payload)
    win.showInactive()
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

export function hidePreview(): void {
  if (previewWin && !previewWin.isDestroyed()) previewWin.hide()
}

/** 预览卡（建议/结果卡）当前是否可见——持续监控用它避免覆盖用户正在看的卡 */
export function isPreviewVisible(): boolean {
  return !!previewWin && !previewWin.isDestroyed() && previewWin.isVisible()
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
