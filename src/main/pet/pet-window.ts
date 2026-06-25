// 桌宠窗口 —— 静态品牌标（纸壳助手橙色 mark），透明无边框置顶窗口。
// 点击穿透、手动拖拽、事件气泡 移植/精简自 openpets pet-window.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
// 动画/运动引擎/反应映射 已全部移除：桌宠是一张静态图标，事件只通过气泡通知。单例。
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import petMark from '../../../resources/pet/pet-mark.png?asset'
import { PET_ART_HEIGHT, PET_ART_WIDTH, type PetReaction } from './reaction-mapping'
import { getPetPrefs, savePetPrefs, type PetScaleValue } from './state'
import { petPreloadPath, petUserDataDir } from './paths'

const PET_WIN_WIDTH = 340
const PET_WIN_HEIGHT = 420

type PetRecord = {
  reaction: PetReaction
  bubbleText: string | null
}
const records = new WeakMap<BrowserWindow, PetRecord>()

let currentPet: BrowserWindow | null = null
let onClickHandler: (() => void) | null = null
let ipcInstalled = false

// 拖拽状态（单例桌宠）
let dragging = false
let dragOffset: { dx: number; dy: number } | null = null

// 主进程光标轮询：决定桌宠窗口是否穿透（见 syncInteractivity）。
let cursorPoll: ReturnType<typeof setInterval> | null = null
let lastInteractiveWant: boolean | null = null

function accessor(): BrowserWindow | null {
  return currentPet && !currentPet.isDestroyed() ? currentPet : null
}

export interface CreatePetOptions {
  onClick: () => void
}

export function createPetWindow(opts: CreatePetOptions): BrowserWindow {
  if (currentPet && !currentPet.isDestroyed()) return currentPet
  onClickHandler = opts.onClick

  const prefs = getPetPrefs()
  const pos = prefs.position ?? defaultPosition()

  const win = new BrowserWindow({
    width: PET_WIN_WIDTH,
    height: PET_WIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false, // 我们用 JS 手动拖拽
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: petPreloadPath(), backgroundThrottling: false }
  })
  // 用普通置顶层级（构造器 alwaysOnTop:true = floating，已浮在普通窗口之上）。
  // 不用 'screen-saver' 超高层级 + setVisibleOnAllWorkspaces：那会让 macOS 把本窗当「面板窗」、
  // 不注册为拖放目标，导致拖文件到桌宠的 dragover/drop 永远不触发（实测定位）。
  // 代价：桌宠不再显示于全屏 App 之上 / 所有工作区。

  currentPet = win
  records.set(win, { reaction: 'idle', bubbleText: null })
  installIpc()

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true })
  })
  win.on('closed', () => {
    if (currentPet === win) currentPet = null
    if (cursorPoll) {
      clearInterval(cursorPoll)
      cursorPoll = null
    }
    lastInteractiveWant = null
  })

  if (!cursorPoll) cursorPoll = setInterval(syncInteractivity, 100)
  renderInto(win)
  if (prefs.enabled) win.showInactive() // 暂停态仍显示（变暗），仅 enabled 控制显隐
  return win
}

export function getPetWindow(): BrowserWindow | null {
  return accessor()
}

export function showPet(): void {
  const win = accessor()
  if (win && !win.isVisible()) win.showInactive()
}
export function hidePet(): void {
  const win = accessor()
  if (win && win.isVisible()) win.hide()
}
export function isPetVisible(): boolean {
  const win = accessor()
  return !!win && win.isVisible()
}

/** 桌宠圆徽章在屏幕上的实际矩形（窗口底部居中，其余为透明空白）；桌宠不可见时返回 null。
 *  用于把通知卡/对话框贴到图标真实位置旁，而非空窗口边缘。 */
export function getPetBadgeBounds(): { x: number; y: number; width: number; height: number } | null {
  const win = accessor()
  if (!win || !win.isVisible()) return null
  const b = win.getBounds()
  const petBottom = 22
  const d = Math.ceil(PET_ART_WIDTH * getPetPrefs().scale)
  return {
    x: Math.round(b.x + b.width / 2 - d / 2),
    y: Math.round(b.y + b.height - petBottom - d),
    width: d,
    height: d
  }
}
export function destroyPet(): void {
  const win = accessor()
  if (win) win.destroy()
  currentPet = null
}

/** 显示/清除气泡（text=null 清除）。整体重生成 body 推过去。 */
export function setPetBubble(text: string | null, reaction?: PetReaction): void {
  const win = accessor()
  if (!win) return
  const rec = records.get(win)
  if (!rec) return
  rec.bubbleText = text
  if (reaction) rec.reaction = reaction
  win.webContents.send('openpets:pet-content-state', {
    bodyHtml: bodyMarkup(rec.reaction, rec.bubbleText)
  })
}

/** 扫描/解析中：桌宠显示 Siri 式旋转光环（切 class，不重渲染）。 */
export function setPetScanning(on: boolean): void {
  const win = accessor()
  if (win) win.webContents.send('openpets:pet-scanning', on)
}

export function setPetScale(scale: PetScaleValue): void {
  savePetPrefs({ scale })
  const win = accessor()
  if (win) renderInto(win)
}

export function setPetPaused(paused: boolean): void {
  savePetPrefs({ paused })
  const win = accessor()
  if (win) renderInto(win)
}

export function resetPetPosition(): void {
  const pos = defaultPosition()
  savePetPrefs({ position: pos })
  const win = accessor()
  if (win) win.setPosition(pos.x, pos.y, false)
}

// ---------------------------------------------------------------------------

function defaultPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - PET_WIN_WIDTH - 24),
    y: Math.round(workArea.y + workArea.height - PET_WIN_HEIGHT - 24)
  }
}

function cursorOverBadge(): boolean {
  const b = getPetBadgeBounds()
  if (!b) return false
  const p = screen.getCursorScreenPoint()
  // 圆形热区：贴合可见圆徽章（外接正方形的内切圆 + 3px 便于边缘拾取）。
  // 用方形 bounds 会把四角空白也变成可点/可拖入区，与圆形视觉不一致。
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const r = b.width / 2 + 3
  return (p.x - cx) ** 2 + (p.y - cy) ** 2 <= r * r
}

// OS 文件拖拽期间没有 mousemove 触发渲染层 hit-test，靠主进程轮询光标：进入徽章就临时关穿透，
// 使拖拽/drop（以及点击/拖动桌宠）能落到窗口；离开且非拖动中恢复穿透，不挡屏幕右下角。
function syncInteractivity(): void {
  const win = accessor()
  if (!win) return
  const want = dragging || cursorOverBadge()
  if (want === lastInteractiveWant) return
  lastInteractiveWant = want
  win.setIgnoreMouseEvents(!want, { forward: true })
}

function installIpc(): void {
  if (ipcInstalled) return
  ipcInstalled = true

  const fromPet = (e: Electron.IpcMainEvent): boolean =>
    !!currentPet && !currentPet.isDestroyed() && e.sender === currentPet.webContents

  ipcMain.on('openpets:pet-drag-start', (e, p: { screenX: number; screenY: number }) => {
    if (!fromPet(e)) return
    const [wx, wy] = currentPet!.getPosition()
    dragOffset = { dx: wx - p.screenX, dy: wy - p.screenY }
    dragging = true
  })
  ipcMain.on('openpets:pet-drag-move', (e, p: { screenX: number; screenY: number }) => {
    if (!fromPet(e) || !dragging || !dragOffset) return
    currentPet!.setPosition(Math.round(p.screenX + dragOffset.dx), Math.round(p.screenY + dragOffset.dy), false)
  })
  ipcMain.on('openpets:pet-drag-end', (e) => {
    if (!fromPet(e)) return
    dragging = false
    dragOffset = null
    persistPosition(currentPet!)
  })
  ipcMain.on('openpets:pet-clicked', (e) => {
    if (!fromPet(e)) return
    onClickHandler?.()
  })
  ipcMain.on('openpets:pet-ready', () => {
    /* 渲染层就绪：当前无需额外动作，hit-test 已接管穿透。 */
  })
}

function persistPosition(win: BrowserWindow): void {
  const [x, y] = win.getPosition()
  const d = screen.getDisplayNearestPoint({ x: x + PET_WIN_WIDTH / 2, y: y + PET_WIN_HEIGHT / 2 })
  const key = `${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`
  const perMonitor = { ...getPetPrefs().perMonitor, [key]: { x, y } }
  savePetPrefs({ position: { x, y }, perMonitor })
}

function renderInto(win: BrowserWindow): void {
  const rec = records.get(win) ?? { reaction: 'idle' as PetReaction, bubbleText: null }
  const html = fullHtml(rec.reaction, rec.bubbleText)
  const dir = petUserDataDir()
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'pet.html')
    writeFileSync(file, html, 'utf8')
    void win.loadFile(file)
  } catch {
    // 写盘/加载失败：桌宠不致命，保持上次内容。
  }
}

// ---------- HTML / CSS 生成 ----------

function bodyMarkup(reaction: PetReaction, bubbleText: string | null): string {
  const markUrl = pathToFileURL(petMark).toString()
  // 有气泡（新消息）时给图标加一次性弹跳，吸引注意；无气泡则静止。
  const alert = bubbleText ? ' is-alert' : ''
  const mark = `<img class="mark" src="${escapeHtml(markUrl)}" alt="纸壳助手" draggable="false" />`
  const bubble = bubbleText ? bubbleMarkup(bubbleText, reaction) : ''
  return `<div class="stage" aria-label="纸壳助手桌宠">
    ${bubble}
    <div class="pet-hitbox" aria-hidden="true"><div class="pet-shell${alert}">${mark}</div></div>
  </div>`
}

function bubbleMarkup(text: string, reaction: PetReaction): string {
  return `<div class="bubble ${bubbleTone(reaction)}"><div class="bubble-text">${escapeHtml(text)}</div></div>`
}

function bubbleTone(reaction: PetReaction): string {
  if (reaction === 'success' || reaction === 'celebrating') return 'is-success'
  if (reaction === 'error') return 'is-error'
  if (reaction === 'waiting' || reaction === 'testing') return 'is-waiting'
  if (reaction === 'thinking' || reaction === 'working' || reaction === 'editing' || reaction === 'running')
    return 'is-busy'
  return 'is-info'
}

function fullHtml(reaction: PetReaction, bubbleText: string | null): string {
  const prefs = getPetPrefs()
  const scale = prefs.scale
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>纸壳助手桌宠</title>
    <style>
      ${windowCss(prefs.paused, scale, nativeTheme.shouldUseDarkColors)}
    </style>
  </head>
  <body>
    ${bodyMarkup(reaction, bubbleText)}
  </body>
</html>`
}

function windowCss(paused: boolean, scale: PetScaleValue, isDark: boolean): string {
  const opacity = paused ? '0.62' : '1'
  // 圆形徽章直径（方形）。图标居中放在圈里，整体更精致。
  const diameter = Math.ceil(PET_ART_WIDTH * scale)
  const petBottom = 22
  const hitPadding = 14
  const bubbleBottom = Math.ceil(petBottom + diameter + 8)
  // 跟随系统深浅色：徽章底 + 气泡 颜色
  const badgeBg = isDark ? 'linear-gradient(180deg, #2c2d33, #232429)' : 'linear-gradient(180deg, #ffffff, #f5f4f1)'
  const badgeRing = isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(15, 23, 42, 0.06)'
  const bubbleBg = isDark
    ? 'linear-gradient(135deg, #2b2c32, #232429)'
    : 'linear-gradient(135deg, rgba(255, 247, 237, 0.98), rgba(254, 243, 226, 0.96))'
  const bubbleFg = isDark ? '#ececef' : '#2a2117'
  const bubbleBorder = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.78)'
  const bubbleTail = isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(255, 255, 255, 0.56)'
  return `
    :root { color-scheme: ${isDark ? 'dark' : 'light'}; --pet-opacity: ${opacity}; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; user-select: none; -webkit-font-smoothing: antialiased; }
    html { color: ${bubbleFg}; }
    body { pointer-events: none; }
    .stage { width: 100%; height: 100%; position: relative; box-sizing: border-box; overflow: visible; }
    .pet-hitbox { position: absolute; left: 50%; bottom: ${Math.max(0, petBottom - hitPadding)}px; z-index: 1; width: ${diameter + hitPadding * 2}px; height: ${diameter + hitPadding * 2}px; display: grid; place-items: center; transform: translateX(-50%); pointer-events: auto; -webkit-app-region: no-drag; cursor: grab; }
    .pet-shell { position: relative; width: ${diameter}px; height: ${diameter}px; border-radius: 50%; display: grid; place-items: center; background: ${badgeBg}; box-shadow: inset 0 0 0 1px ${badgeRing}; opacity: var(--pet-opacity); filter: drop-shadow(0 6px 14px rgba(15, 23, 42, 0.20)) drop-shadow(0 1px 3px rgba(15, 23, 42, 0.12)); transition: opacity 180ms cubic-bezier(0.2, 0, 0, 1), transform 140ms cubic-bezier(0.2, 0.7, 0.3, 1); pointer-events: auto; -webkit-app-region: no-drag; cursor: grab; }
    .mark { display: block; width: 56%; height: 56%; object-fit: contain; -webkit-user-drag: none; user-select: none; pointer-events: none; }
    .pet-shell.is-alert { animation: mark-pop 460ms cubic-bezier(0.2, 0.7, 0.3, 1) 1; transform-origin: 50% 50%; }
    .pet-shell.is-clicked { animation: click-pop 280ms cubic-bezier(0.2, 0.7, 0.3, 1) 1; transform-origin: 50% 50%; }
    html.pet-drag-over .pet-shell { box-shadow: inset 0 0 0 2px #e2893a, 0 0 0 5px rgba(226, 137, 58, 0.22); transform: scale(1.06); animation: drag-pulse 1000ms ease-in-out infinite; }
    @keyframes mark-pop { 0% { transform: scale(1); } 30% { transform: scale(1.12); } 55% { transform: scale(0.96); } 78% { transform: scale(1.03); } 100% { transform: scale(1); } }
    @keyframes click-pop { 0% { transform: scale(1); } 35% { transform: scale(1.15); } 100% { transform: scale(1); } }
    @keyframes drag-pulse { 0%, 100% { transform: scale(1.045); box-shadow: inset 0 0 0 2px #e2893a, 0 0 0 4px rgba(226, 137, 58, 0.16); } 50% { transform: scale(1.105); box-shadow: inset 0 0 0 2px #e2893a, 0 0 0 10px rgba(226, 137, 58, 0.34); } }
    .bubble { position: absolute; left: 50%; bottom: ${bubbleBottom}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 80px; max-width: min(220px, calc(100vw - 18px)); padding: 9px 12px; background: ${bubbleBg}; color: ${bubbleFg}; font: 700 12px/16px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; text-align: left; border: 1px solid ${bubbleBorder}; border-radius: 14px; box-shadow: 0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12); white-space: normal; overflow-wrap: break-word; pointer-events: auto; -webkit-app-region: no-drag; transform: translateX(-50%); transform-origin: 64% 100%; animation: bubble-in 180ms cubic-bezier(0.2, 0, 0, 1); }
    .bubble::after { content: ""; position: absolute; left: 64%; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid ${bubbleTail}; border-bottom: 1px solid ${bubbleTail}; border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg); }
    .bubble-text { display: -webkit-box; min-width: 0; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow-wrap: break-word; }
    .bubble.is-success { border-color: rgba(16, 185, 129, 0.4); }
    .bubble.is-error { border-color: rgba(239, 68, 68, 0.4); }
    .bubble.is-waiting { border-color: rgba(245, 158, 11, 0.45); }
    .bubble.is-busy { border-color: rgba(59, 130, 246, 0.4); }
    .bubble.is-info { border-color: rgba(56, 189, 248, 0.4); }
    @keyframes bubble-in { from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
    /* 扫描/解析中：Siri 式旋转锥形光环 + 呼吸光晕（环挂在徽章外缘） */
    html.pet-scanning .pet-shell { animation: scan-breathe 1.8s ease-in-out infinite; }
    html.pet-scanning .pet-shell::before { content: ""; position: absolute; inset: -5px; border-radius: 50%; background: conic-gradient(from 0deg, #f59e0b, #fbbf24, #fb7185, #a78bfa, #38bdf8, #34d399, #f59e0b); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px)); mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px)); filter: blur(0.4px); opacity: 0.92; z-index: -1; animation: scan-spin 1s linear infinite; }
    @keyframes scan-spin { to { transform: rotate(1turn); } }
    @keyframes scan-breathe { 0%, 100% { filter: drop-shadow(0 6px 14px rgba(15, 23, 42, 0.2)); transform: scale(1); } 50% { filter: drop-shadow(0 6px 14px rgba(15, 23, 42, 0.2)) drop-shadow(0 0 9px rgba(251, 146, 60, 0.55)); transform: scale(1.03); } }
    @media (prefers-reduced-motion: reduce) { .bubble, .pet-shell, html.pet-scanning .pet-shell::before { animation: none !important; } }
  `
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 系统深浅色切换：重渲染桌宠徽章/气泡以套用新主题
nativeTheme.on('updated', () => {
  const win = accessor()
  if (win) renderInto(win)
})
