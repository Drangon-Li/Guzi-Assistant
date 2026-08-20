// 快捷提问框 —— 全局快捷键唤起的聚焦搜索式悬浮输入条（仿 macOS Spotlight / ChatGPT 桌面版）。
// Spotlight 式半透明：原生 vibrancy 磨砂 + 原生圆角与窗口阴影（transparent 窗两样都拿不到，
// CSS 阴影在深浅背景上会显得突兀）；进出用窗口透明度渐变，贴近聚焦搜索的观感。
// 独立气泡对话模式：Enter 单入口（问答/记日程/口头任务指令都走助手），回答在条上方气泡展开。
// 对话展开时渲染层汇报内容高度，窗口底边固定向上生长（水平居中贴近屏幕下方，错开系统聚焦搜索）。
import { app, BrowserWindow, screen } from 'electron'
import { debugEvent, load, preload } from './windows'

const QB_W = 660
const QB_H = 58
const QB_MAX_H = 560
const FADE_MS = 120

let qbWin: BrowserWindow | null = null
let fadeTimer: ReturnType<typeof setInterval> | null = null
let resignHooked = false

function ensureWindow(): BrowserWindow {
  if (qbWin && !qbWin.isDestroyed()) return qbWin
  // 兜底：应用整体失活（用户切去别的 App）也收起——个别场景（副屏/全屏 Space）
  // 窗口级 blur 可能收不到，应用级 resign 一定收得到
  if (!resignHooked) {
    resignHooked = true
    app.on('did-resign-active', () => {
      if (qbWin && !qbWin.isDestroyed() && qbWin.isVisible()) {
        debugEvent('quickbar', 'app did-resign-active → 自动收起')
        hideQuickBar()
      }
    })
  }
  const win = new BrowserWindow({
    width: QB_W,
    height: QB_H,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    // 'menu' 一族材质透亮（聚焦搜索观感）；'under-window' 偏灰闷，背景几乎透不出来
    vibrancy: 'menu',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    roundedCorners: true,
    webPreferences: { preload, backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('blur', () => {
    debugEvent('quickbar', 'blur → 自动收起')
    hideQuickBar()
  })
  win.on('closed', () => {
    if (qbWin === win) qbWin = null
  })
  load(win, '/quickbar')
  qbWin = win
  return win
}

/** 窗口透明度渐变（连磨砂和原生阴影一起淡入淡出，CSS 动不了这两层）。 */
function fadeWindow(win: BrowserWindow, from: number, to: number, done?: () => void): void {
  if (fadeTimer) clearInterval(fadeTimer)
  const steps = Math.max(1, Math.round(FADE_MS / 16))
  let i = 0
  win.setOpacity(from)
  fadeTimer = setInterval(() => {
    i++
    if (win.isDestroyed()) {
      if (fadeTimer) clearInterval(fadeTimer)
      fadeTimer = null
      return
    }
    win.setOpacity(from + ((to - from) * i) / steps)
    if (i >= steps) {
      if (fadeTimer) clearInterval(fadeTimer)
      fadeTimer = null
      done?.()
    }
  }, 16)
}

/** 启动时预创建（隐藏），首次按快捷键即秒开。 */
export function createQuickBar(): void {
  ensureWindow()
}

export function showQuickBar(): void {
  const win = ensureWindow()
  // 跟随鼠标所在屏幕，水平居中、贴近屏幕下方（上三分之一让给系统聚焦搜索，避免视觉重合）。
  // 每次唤起渲染层会清空对话（新会话），窗口高度随后收缩；此刻仍按当前高度做底边对齐即可
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const h = win.getBounds().height
  win.setPosition(Math.round(wa.x + (wa.width - QB_W) / 2), Math.round(wa.y + wa.height - h - 60), false)
  const notify = (): void => win.webContents.send('guzi-assistant:quickbar-show')
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', notify)
  else notify()
  win.setOpacity(0)
  win.show()
  // 其他 App 前台（尤其副屏场景）时单靠 win.focus() 抢不到跨应用焦点：窗口从未获焦 →
  // blur 永不触发 → 点外面关不掉、也打不了字。先把应用抢到前台，再聚焦本窗成为 key window。
  app.focus({ steal: true })
  win.focus()
  fadeWindow(win, 0, 1)
  // 焦点看门狗：实测首次抢焦点会间歇性失败（副屏「关不掉」的根源——从未获焦则 blur/resign
  // 都不会来）。250ms 没获焦立刻再抢一次；仍失败则主动收起，绝不让条挂死在屏上。
  setTimeout(() => {
    if (win.isDestroyed() || !win.isVisible() || win.isFocused()) return
    debugEvent('quickbar', 'shown 但未获焦，重试抢焦点')
    app.focus({ steal: true })
    win.focus()
    setTimeout(() => {
      if (!win.isDestroyed() && win.isVisible() && !win.isFocused()) {
        debugEvent('quickbar', '两次抢焦点失败 → 主动收起，避免挂死')
        hideQuickBar()
      }
    }, 500)
  }, 250)
}

export function hideQuickBar(): void {
  if (!qbWin || qbWin.isDestroyed() || !qbWin.isVisible()) return
  const win = qbWin
  fadeWindow(win, win.getOpacity(), 0, () => {
    if (!win.isDestroyed()) {
      win.hide()
      win.setOpacity(1)
    }
  })
}

/** 渲染层内容高度变化（对话展开/收起）：底边固定，向上调整窗口高度。 */
export function resizeQuickBar(height: number): void {
  if (!qbWin || qbWin.isDestroyed()) return
  const h = Math.max(QB_H, Math.min(QB_MAX_H, Math.round(height)))
  const b = qbWin.getBounds()
  if (h === b.height) return
  qbWin.setBounds({ x: b.x, y: b.y + b.height - h, width: b.width, height: h })
}

export function toggleQuickBar(): void {
  if (qbWin && !qbWin.isDestroyed() && qbWin.isVisible()) hideQuickBar()
  else showQuickBar()
}
