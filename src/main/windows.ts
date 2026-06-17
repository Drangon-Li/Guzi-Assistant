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
    title: '纸壳助手',
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
    width: 320,
    height: 240,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    // 预览卡是常驻置顶、从不获焦的通知窗（showInactive）。默认后台节流会把不获焦窗口降到极低帧率，
    // 导致定时器触发的滑出动画被跳帧、看起来"直接消失"（点 ✕ 时有交互才正常播放）。关掉节流，
    // 让自动隐藏的滑出动画也能完整播放。
    webPreferences: { preload, backgroundThrottling: false }
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
  win.setPosition(workArea.x + workArea.width - 336, workArea.y + workArea.height - 256)
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

let debugWin: BrowserWindow | null = null

/** 开发用调试监控面板（独立窗口）：实时显示屏幕感知管线每一步。 */
export function openDebugWindow(): void {
  if (debugWin && !debugWin.isDestroyed()) {
    debugWin.show()
    debugWin.focus()
    return
  }
  debugWin = new BrowserWindow({
    width: 460,
    height: 760,
    title: '纸壳助手 · 调试监控',
    backgroundColor: '#0b0b0f',
    webPreferences: { preload }
  })
  debugWin.on('closed', () => {
    debugWin = null
  })
  load(debugWin, '/debug')
}

/** 调试窗是否开着——主进程据此决定要不要做额外开销（如生成截图缩略图）。 */
export function debugIsOpen(): boolean {
  return !!debugWin && !debugWin.isDestroyed()
}

/** 向调试窗推一条事件（窗没开则忽略，零开销）。 */
export function debugEvent(stage: string, message: string, extra?: Record<string, unknown>): void {
  if (debugWin && !debugWin.isDestroyed())
    debugWin.webContents.send('eshell:debug', { ts: Date.now(), stage, message, ...extra })
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
