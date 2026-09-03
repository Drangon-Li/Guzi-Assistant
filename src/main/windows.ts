import { app, BrowserWindow, nativeTheme, screen } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { getPetBadgeBounds } from './pet/pet-window'

export const appState = { quitting: false }

let mainWin: BrowserWindow | null = null
let previewWin: BrowserWindow | null = null

export const preload = join(__dirname, '../preload/index.js')

export function load(win: BrowserWindow, hash: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) win.loadURL(`${devUrl}#${hash}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

/** showOnReady=false 用于开机自启：窗口照建（快捷键/托盘随时能拉出来），只是不主动露脸 */
export function createMainWindow(showOnReady = true): BrowserWindow {
  if (mainWin && !mainWin.isDestroyed()) return mainWin
  mainWin = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    title: '谷子助手',
    show: false,
    // 现代 macOS 风格：隐藏标题栏，红黄绿交通灯浮在侧栏上方（与设计稿一致）
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161719' : '#ffffff',
    webPreferences: { preload }
  })
  mainWin.on('ready-to-show', () => {
    if (showOnReady) mainWin?.show()
  })
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
  if (route) win.webContents.send('guzi-assistant:navigate', route)
}

/**
 * 手动扫描前把主窗让开，返回恢复函数；本来就不可见时返回 null（无须恢复）。
 *
 * 用户是点着界面上的按钮触发扫描的，所以前台必然是谷子助手自己——直接截等于截自己。
 * 这里只隐藏主窗（不用 app.hide()，那样桌宠和预览卡会跟着消失），
 * macOS 随即把焦点还给上一个应用，那才是用户想让谷子看的东西。
 * 刻意不调 createMainWindow()：它在窗口不存在时会新建一个。
 */
export function hideMainForCapture(): (() => void) | null {
  if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) return null
  const win = mainWin
  win.hide()
  // 幂等：截完立刻恢复（别让用户干等 OCR 和云端解析），出错路径再由 finally 兜一次
  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (!win.isDestroyed()) win.show()
  }
}

/** 切换主窗口显隐：已显示 → 隐藏；隐藏/最小化 → 显示并获焦。供双击桌宠调用。 */
export function toggleMainWindow(): void {
  const win = createMainWindow()
  if (win.isVisible()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

const PREVIEW_W = 320
const PREVIEW_H = 240
/** 清单卡要列出多条候选，240 高会把列表和按钮裁掉 */
const PREVIEW_BATCH_H = 420
const PREVIEW_MIN_H = 96
const PREVIEW_MAX_H = 520
const PREVIEW_FADE_MS = 140

let previewFadeTimer: ReturnType<typeof setInterval> | null = null

export function getPreviewWindow(): BrowserWindow {
  if (previewWin && !previewWin.isDestroyed()) return previewWin
  previewWin = new BrowserWindow({
    width: PREVIEW_W,
    height: PREVIEW_H,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    // 原生磨砂 + 原生圆角/阴影（与 QuickBar/提醒窗同款）：transparent 窗拿不到原生阴影，
    // CSS 阴影会被窗口边缘裁切出硬边。'menu' 材质透亮；从不获焦故 visualEffectState 固定 active。
    vibrancy: 'menu',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    roundedCorners: true,
    // 预览卡是常驻置顶、从不获焦的通知窗（showInactive）。默认后台节流会把不获焦窗口降到极低帧率，
    // 导致定时器驱动的倒计时进度条跳帧。关掉节流保证动画完整。
    webPreferences: { preload, backgroundThrottling: false }
  })
  previewWin.setAlwaysOnTop(true, 'screen-saver')
  previewWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  load(previewWin, '/preview')
  return previewWin
}

/** 窗口透明度渐变（磨砂和原生阴影只能整窗淡入淡出，CSS 动不了这两层）。 */
function fadePreview(win: BrowserWindow, from: number, to: number, done?: () => void): void {
  if (previewFadeTimer) clearInterval(previewFadeTimer)
  const steps = Math.max(1, Math.round(PREVIEW_FADE_MS / 16))
  let i = 0
  win.setOpacity(from)
  previewFadeTimer = setInterval(() => {
    i++
    if (win.isDestroyed()) {
      if (previewFadeTimer) clearInterval(previewFadeTimer)
      previewFadeTimer = null
      return
    }
    win.setOpacity(from + ((to - from) * i) / steps)
    if (i >= steps) {
      if (previewFadeTimer) clearInterval(previewFadeTimer)
      previewFadeTimer = null
      done?.()
    }
  }, 16)
}

/** 弹出预览/通知卡，不抢焦点。桌宠可见时贴到桌宠图标旁（气泡感），否则回退右下角默认位置。 */
export function showPreview(payload: unknown): void {
  const win = getPreviewWindow()
  const batch = !!(payload as { localBatch?: unknown } | null)?.localBatch
  // 首帧用预估高度，渲染层 ResizeObserver 汇报实际内容高度后再校正；
  // 已可见时不重设尺寸，避免和 preview:resize 互相拉扯
  if (!win.isVisible()) win.setSize(PREVIEW_W, batch ? PREVIEW_BATCH_H : PREVIEW_H)
  const petMode = positionPreview(win)
  const enriched =
    payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>), petMode } : payload
  const send = (): void => {
    win.webContents.send('guzi-assistant:preview', enriched)
    if (win.isVisible()) return
    win.setOpacity(0)
    win.showInactive()
    fadePreview(win, 0, 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

/** 渲染层内容高度变化：底边固定（贴桌宠/右下角都是底对齐），向上调整窗口高度。 */
export function resizePreview(height: number): void {
  if (!previewWin || previewWin.isDestroyed()) return
  const h = Math.max(PREVIEW_MIN_H, Math.min(PREVIEW_MAX_H, Math.round(height)))
  const b = previewWin.getBounds()
  if (h === b.height) return
  previewWin.setBounds({ x: b.x, y: b.y + b.height - h, width: b.width, height: h })
}

/** 定位通知卡；返回是否已贴到桌宠旁（true=桌宠模式，渲染层据此隐藏冗余品牌行）。
 *  高度取窗口当前实际高度——清单卡比普通卡高，写死 240 会让它贴错位置。 */
function positionPreview(win: BrowserWindow): boolean {
  const height = win.getBounds().height
  if (anchorWindowNearPet(win, PREVIEW_W, height)) return true // 桌宠可见：贴图标旁
  const { workArea } = screen.getPrimaryDisplay()
  win.setPosition(
    workArea.x + workArea.width - PREVIEW_W - 16,
    workArea.y + workArea.height - height - 16
  )
  return false
}

/** 把窗口贴到桌宠图标旁（左侧，放不下→右侧），夹进可见工作区。桌宠不可见返回 false。
 *  预览卡与桌宠对话框共用此定位逻辑。 */
export function anchorWindowNearPet(win: BrowserWindow, w: number, h: number, gap = 12): boolean {
  const badge = getPetBadgeBounds()
  if (!badge) return false
  const wa = screen.getDisplayNearestPoint({ x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 }).workArea
  let x = badge.x - w - gap
  if (x < wa.x + 8) x = badge.x + badge.width + gap
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - w - 8)
  let y = badge.y + badge.height - h
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - h - 8)
  win.setPosition(Math.round(x), Math.round(y))
  return true
}

/** 广播当前深浅色给所有渲染窗口 + 同步主窗原生背景色（避免主题切换时窗框底色滞后/闪烁）。 */
export function broadcastTheme(): void {
  const dark = nativeTheme.shouldUseDarkColors
  if (mainWin && !mainWin.isDestroyed()) mainWin.setBackgroundColor(dark ? '#161719' : '#ffffff')
  broadcast('guzi-assistant:theme', { dark })
}

/** 桌宠移动/变大小时，把贴在旁边的通知卡重新对齐（卡不可见时零开销）。 */
export function repositionPreviewNearPet(): void {
  if (previewWin && !previewWin.isDestroyed() && previewWin.isVisible()) positionPreview(previewWin)
}

export function hidePreview(): void {
  if (!previewWin || previewWin.isDestroyed() || !previewWin.isVisible()) return
  const win = previewWin
  fadePreview(win, win.getOpacity(), 0, () => {
    if (!win.isDestroyed()) {
      win.hide()
      win.setOpacity(1)
    }
  })
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
    title: '谷子助手 · 调试监控',
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
    debugWin.webContents.send('guzi-assistant:debug', { ts: Date.now(), stage, message, ...extra })
  // 诊断：同时落盘到 userData/screen-sense-debug.log（排除带大图的 screenshot），便于离线排查
  try {
    if (stage !== 'screenshot')
      appendFileSync(
        join(app.getPath('userData'), 'screen-sense-debug.log'),
        `[${new Date().toISOString()}] ${stage}: ${message}\n`
      )
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 广播给除发起窗口外的其他窗口：发起方界面已是最新，回推会打断它正在输入的人。 */
export function broadcastExcept(senderId: number, channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents.id !== senderId) win.webContents.send(channel, payload)
  }
}
