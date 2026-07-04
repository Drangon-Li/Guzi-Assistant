// 桌宠窗口 —— 静态品牌标（谷子助手橙色 mark），透明无边框置顶窗口。
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
// 徽章圆边距屏幕左/右边缘 ≤ 此值时松手 → 吸附成半圆侧边标签
const DOCK_SNAP_PX = 20
// 徽章底边距窗口底部的固定留白（气泡/徽章几何共用）
const PET_BOTTOM = 22

type PetRecord = {
  reaction: PetReaction
  bubbleText: string | null
}
const records = new WeakMap<BrowserWindow, PetRecord>()

let currentPet: BrowserWindow | null = null
let onClickHandler: (() => void) | null = null
let onDblClickHandler: (() => void) | null = null
let onLongPressStartHandler: (() => void) | null = null
let onLongPressEndHandler: (() => void) | null = null
let onPetMovedHandler: (() => void) | null = null
let ipcInstalled = false

/** 桌宠位置/大小变化时的回调（index 接线：让贴在旁边的通知卡跟着走）。
 *  用注入而非直接 import windows.ts——后者已 import 本模块，反向引用会成环。 */
export function setOnPetMoved(fn: () => void): void {
  onPetMovedHandler = fn
}

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
  onDblClick: () => void
  /** 长按开始（按住桌宠到点）：唤起语音助手，同时给桌宠"聆听中"反馈。 */
  onLongPressStart?: () => void
  /** 长按松开：结束语音会话。 */
  onLongPressEnd?: () => void
}

export function createPetWindow(opts: CreatePetOptions): BrowserWindow {
  if (currentPet && !currentPet.isDestroyed()) return currentPet
  onClickHandler = opts.onClick
  onDblClickHandler = opts.onDblClick
  onLongPressStartHandler = opts.onLongPressStart ?? null
  onLongPressEndHandler = opts.onLongPressEnd ?? null

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
  // 用普通置顶层级（构造器 alwaysOnTop:true = floating，已浮在普通窗口之上），不抬到
  // 'screen-saver' 超高层级——那会让 macOS 把本窗当「面板窗」、不注册为拖放目标，导致拖文件到
  // 桌宠的 dragover/drop 永远不触发（实测定位）。
  // 跨工作区跟随：单独用 setVisibleOnAllWorkspaces（保持普通层级，不配 screen-saver），让桌宠
  // 跟随三指切换桌面 / 显示在全屏 App 上。保持普通层级是为尽量不破坏拖放（拖文件需回归验证）。
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

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
  // 上次退出时处于吸附态：按当前屏幕重算吸附几何（也顺带矫正旧版本存的贴边坐标）
  if (prefs.dock) applyDockGeometry(win, prefs.dock)
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
  const d = Math.ceil(PET_ART_WIDTH * getPetPrefs().scale)
  // 徽章锚点恒为窗口中心（吸附靠窗口半出屏实现，不切锚点），bounds 可能部分在屏外
  return {
    x: Math.round(b.x + b.width / 2 - d / 2),
    y: Math.round(b.y + b.height - PET_BOTTOM - d),
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

/** 长按聆听中：桌宠显示橙色声波涟漪（切 class，不重渲染；与处理光环视觉区分）。 */
export function setPetListening(on: boolean): void {
  const win = accessor()
  if (win) win.webContents.send('openpets:pet-listening', on)
}

export function setPetScale(scale: PetScaleValue): void {
  savePetPrefs({ scale })
  const win = accessor()
  if (win) renderInto(win)
  onPetMovedHandler?.() // 徽章大小变了，锚在旁边的卡重新对齐
}

export function setPetPaused(paused: boolean): void {
  savePetPrefs({ paused })
  const win = accessor()
  if (win) renderInto(win)
}

export function resetPetPosition(): void {
  const win = accessor()
  if (win) applyDock(win, null)
  else savePetPrefs({ dock: null })
  const pos = defaultPosition()
  savePetPrefs({ position: pos })
  if (win) win.setPosition(pos.x, pos.y, false)
  onPetMovedHandler?.()
}

// ---------------------------------------------------------------------------

function defaultPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - PET_WIN_WIDTH - 24),
    y: Math.round(workArea.y + workArea.height - PET_WIN_HEIGHT - 24)
  }
}

/** 应用/解除吸附。吸附 = 纯窗口位置（半出屏，徽章圆心压屏幕边缘），锚点从不变化；
 *  dock 类只管不透明度/图标偏移/气泡侧移等纯装饰。早期实现切 CSS 锚点 + 平移窗口补偿，
 *  但类名走 IPC、坐标走原生，相差 1-2 帧，点击吸附态桌宠会闪现未吸附整圆（用户实测）。 */
function applyDock(win: BrowserWindow, dock: 'left' | 'right' | null): void {
  if (getPetPrefs().dock === dock) return
  savePetPrefs({ dock })
  win.webContents.send('openpets:pet-dock', dock)
  if (dock) applyDockGeometry(win, dock)
  // 解除吸附不动窗口：徽章原地（半贴边），拖离边缘的过程自然把它带出来
}

/** 吸附几何：窗口平移到「徽章圆心正好在屏幕左/右边缘」，纵向夹进工作区。 */
function applyDockGeometry(win: BrowserWindow, dock: 'left' | 'right'): void {
  const [wx, wy] = win.getPosition()
  const d = Math.ceil(PET_ART_WIDTH * getPetPrefs().scale)
  const wa = screen.getDisplayNearestPoint({
    x: wx + PET_WIN_WIDTH / 2,
    y: wy + PET_WIN_HEIGHT - PET_BOTTOM - d / 2
  }).workArea
  const x = dock === 'left' ? wa.x - PET_WIN_WIDTH / 2 : wa.x + wa.width - PET_WIN_WIDTH / 2
  // 纵向夹进工作区：徽章整圆可见（上下各留 8px）
  const minY = wa.y + 8 - (PET_WIN_HEIGHT - PET_BOTTOM - d)
  const maxY = wa.y + wa.height - 8 - PET_WIN_HEIGHT + PET_BOTTOM
  win.setPosition(Math.round(x), Math.round(Math.min(Math.max(wy, minY), maxY)), false)
}

/** 该点是否落在某个显示器内——吸附前确认目标边缘外侧没有邻屏（内侧边吸附会把半圆露在邻屏上）。 */
function pointOnAnyDisplay(x: number, y: number): boolean {
  return screen
    .getAllDisplays()
    .some((d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width && y >= d.bounds.y && y < d.bounds.y + d.bounds.height)
}

/** 松手时看徽章是否贴到了屏幕左/右外侧边缘，是则吸附。 */
function maybeDockAtEdge(win: BrowserWindow): void {
  const [wx, wy] = win.getPosition()
  const d = Math.ceil(PET_ART_WIDTH * getPetPrefs().scale)
  const cx = wx + PET_WIN_WIDTH / 2
  const cy = wy + PET_WIN_HEIGHT - PET_BOTTOM - d / 2
  const wa = screen.getDisplayNearestPoint({ x: cx, y: cy }).workArea
  if (cx - d / 2 <= wa.x + DOCK_SNAP_PX && !pointOnAnyDisplay(wa.x - 8, cy)) applyDock(win, 'left')
  else if (cx + d / 2 >= wa.x + wa.width - DOCK_SNAP_PX && !pointOnAnyDisplay(wa.x + wa.width + 8, cy))
    applyDock(win, 'right')
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
    // 真开始拖动才解除吸附（纯装饰类切换，不动坐标）——单纯点击不折腾 dock 状态
    if (getPetPrefs().dock) applyDock(currentPet!, null)
    currentPet!.setPosition(Math.round(p.screenX + dragOffset.dx), Math.round(p.screenY + dragOffset.dy), false)
    onPetMovedHandler?.() // 贴在旁边的通知卡实时跟走
  })
  ipcMain.on('openpets:pet-drag-end', (e) => {
    if (!fromPet(e)) return
    dragging = false
    dragOffset = null
    maybeDockAtEdge(currentPet!)
    persistPosition(currentPet!)
    onPetMovedHandler?.() // 吸附微调后再对齐一次
  })
  ipcMain.on('openpets:pet-clicked', (e) => {
    if (!fromPet(e)) return
    onClickHandler?.()
  })
  ipcMain.on('openpets:pet-dblclicked', (e) => {
    if (!fromPet(e)) return
    onDblClickHandler?.()
  })
  ipcMain.on('openpets:pet-longpress-start', (e) => {
    if (!fromPet(e)) return
    onLongPressStartHandler?.()
  })
  ipcMain.on('openpets:pet-longpress-end', (e) => {
    if (!fromPet(e)) return
    onLongPressEndHandler?.()
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
  const mark = `<img class="mark" src="${escapeHtml(markUrl)}" alt="谷子助手" draggable="false" />`
  const bubble = bubbleText ? bubbleMarkup(bubbleText, reaction) : ''
  return `<div class="stage" aria-label="谷子助手桌宠">
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
<html lang="zh-CN"${prefs.dock ? ` class="docked-${prefs.dock}"` : ''}>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>谷子助手桌宠</title>
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
  const petBottom = PET_BOTTOM
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
    /* 贴边吸附（窗口半出屏、徽章圆心压屏幕边缘，见 applyDock）：dock 类只做纯装饰——
       降不透明度、图标滑向可见半侧、气泡挪到可见半窗内。锚点/坐标一概不动，避免 IPC 与原生调用的时序闪烁 */
    .mark { transition: transform 220ms cubic-bezier(0.2, 0.7, 0.3, 1); }
    html.docked-left .pet-shell, html.docked-right .pet-shell { opacity: calc(var(--pet-opacity) * 0.85); }
    html.docked-left .pet-shell:hover, html.docked-right .pet-shell:hover { opacity: var(--pet-opacity); }
    html.docked-left .mark { transform: translateX(26%); }
    html.docked-right .mark { transform: translateX(-26%); }
    html.docked-left .bubble, html.docked-right .bubble { animation: none; transform: none; max-width: calc(50% - 16px); }
    html.docked-left .bubble { left: calc(50% + 8px); transform-origin: 12% 100%; }
    html.docked-left .bubble::after { left: 22px; }
    html.docked-right .bubble { left: auto; right: calc(50% + 8px); transform-origin: 88% 100%; }
    html.docked-right .bubble::after { left: auto; right: 16px; }
    .bubble.is-success { border-color: rgba(16, 185, 129, 0.4); }
    .bubble.is-error { border-color: rgba(239, 68, 68, 0.4); }
    .bubble.is-waiting { border-color: rgba(245, 158, 11, 0.45); }
    .bubble.is-busy { border-color: rgba(59, 130, 246, 0.4); }
    .bubble.is-info { border-color: rgba(56, 189, 248, 0.4); }
    @keyframes bubble-in { from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
    /* 扫描/解析中：Siri 式旋转锥形光环 + 呼吸光晕（环挂在徽章外缘） */
    html.pet-scanning .pet-shell { animation: scan-breathe 1.8s ease-in-out infinite; }
    html.pet-scanning .pet-shell::before { content: ""; position: absolute; inset: -4px; border-radius: 50%; background: conic-gradient(from 0deg, #f59e0b, #fbbf24, #fb7185, #a78bfa, #38bdf8, #34d399, #f59e0b); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px)); filter: blur(0.7px); opacity: 0.5; z-index: -1; animation: scan-spin 1.3s linear infinite; }
    @keyframes scan-spin { to { transform: rotate(1turn); } }
    @keyframes scan-breathe { 0%, 100% { filter: drop-shadow(0 6px 14px rgba(15, 23, 42, 0.2)); transform: scale(1); } 50% { filter: drop-shadow(0 6px 14px rgba(15, 23, 42, 0.2)) drop-shadow(0 0 7px rgba(251, 146, 60, 0.3)); transform: scale(1.02); } }
    /* 长按聆听中：品牌橙声波涟漪（两圈交错向外扩散）+ 轻呼吸。规则放在扫描之后，两态同时命中时聆听优先 */
    html.pet-listening .pet-shell { animation: listen-breathe 1.6s ease-in-out infinite; }
    html.pet-listening .pet-shell::before, html.pet-listening .pet-shell::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid rgba(232, 116, 59, 0.55); background: none; -webkit-mask: none; mask: none; filter: none; opacity: 0; z-index: -1; animation: listen-ripple 1.8s ease-out infinite; }
    html.pet-listening .pet-shell::after { animation-delay: 0.9s; }
    @keyframes listen-ripple { 0% { transform: scale(1); opacity: 0.75; } 70% { transform: scale(1.65); opacity: 0; } 100% { transform: scale(1.65); opacity: 0; } }
    @keyframes listen-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.045); filter: drop-shadow(0 6px 14px rgba(15, 23, 42, 0.2)) drop-shadow(0 0 8px rgba(232, 116, 59, 0.35)); } }
    @media (prefers-reduced-motion: reduce) { .bubble, .pet-shell, html.pet-scanning .pet-shell::before, html.pet-listening .pet-shell::before, html.pet-listening .pet-shell::after { animation: none !important; } }
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
