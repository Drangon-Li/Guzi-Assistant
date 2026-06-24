// 桌宠窗口 —— 移植/精简自 openpets pet-window.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
// 自绘 HTML（sprite 雪碧图动画 + 简单气泡），透明无边框置顶窗口；点击穿透 + 手动拖拽 + 运动发布。
// 去掉：installed/agent 宠物、插件气泡/HUD、Linux 形状、Windows rearm、音频/TTS、emoji 字体。单例。
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import spriteAsset from '../../../resources/pet/default-pet-spritesheet.webp?asset'
import {
  defaultPetSprite,
  motionToSpriteState,
  resolveReactionSpriteState,
  type PetMotionState,
  type PetReaction,
  type UniversalSpriteState
} from './reaction-mapping'
import { getPetPrefs, savePetPrefs, type PetScaleValue } from './state'
import { petPreloadPath, petUserDataDir } from './paths'
import { registerPet, setIsPetWindowDragging, unregisterPet } from './motion-engine'

const PET_HANDLE = 'default'
const PET_WIN_WIDTH = 340
const PET_WIN_HEIGHT = 420

const petWindowDragging = new WeakMap<BrowserWindow, boolean>()

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

export function isPetWindowDragging(win: BrowserWindow): boolean {
  return petWindowDragging.get(win) === true
}

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
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  currentPet = win
  records.set(win, { reaction: 'idle', bubbleText: null })
  setIsPetWindowDragging(isPetWindowDragging)
  installIpc()
  installMotionStatePublisher(win)
  registerPet(PET_HANDLE, accessor)

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true })
  })
  win.on('closed', () => {
    unregisterPet(PET_HANDLE)
    if (currentPet === win) currentPet = null
  })

  renderInto(win)
  if (!prefs.paused && prefs.enabled) win.showInactive()
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
export function destroyPet(): void {
  const win = accessor()
  if (win) win.destroy()
  currentPet = null
}

/** 切换 sprite 反应动画（无气泡时走轻量通道，不重载）。 */
export function setPetReactionState(reaction: PetReaction): void {
  const win = accessor()
  if (!win) return
  const rec = records.get(win)
  if (rec) rec.reaction = reaction
  const sprite = resolveReactionSpriteState(reaction, getPetPrefs().reactionOverrides)
  win.webContents.send('openpets:pet-reaction-state', sprite)
}

/** 显示/清除气泡（text=null 清除）。整体重生成 body 推过去。 */
export function setPetBubble(text: string | null, reaction?: PetReaction): void {
  const win = accessor()
  if (!win) return
  const rec = records.get(win)
  if (!rec) return
  rec.bubbleText = text
  if (reaction) rec.reaction = reaction
  const sprite = resolveReactionSpriteState(rec.reaction, getPetPrefs().reactionOverrides)
  win.webContents.send('openpets:pet-content-state', {
    reactionState: sprite,
    bodyHtml: bodyMarkup(rec.reaction, rec.bubbleText)
  })
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

function installIpc(): void {
  if (ipcInstalled) return
  ipcInstalled = true

  const fromPet = (e: Electron.IpcMainEvent): boolean =>
    !!currentPet && !currentPet.isDestroyed() && e.sender === currentPet.webContents

  ipcMain.on('openpets:pet-hit-test', (e, interactive: boolean) => {
    if (!fromPet(e)) return
    currentPet!.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.on('openpets:pet-drag-start', (e, p: { screenX: number; screenY: number }) => {
    if (!fromPet(e)) return
    const [wx, wy] = currentPet!.getPosition()
    dragOffset = { dx: wx - p.screenX, dy: wy - p.screenY }
    dragging = true
    petWindowDragging.set(currentPet!, true)
  })
  ipcMain.on('openpets:pet-drag-move', (e, p: { screenX: number; screenY: number }) => {
    if (!fromPet(e) || !dragging || !dragOffset) return
    currentPet!.setPosition(Math.round(p.screenX + dragOffset.dx), Math.round(p.screenY + dragOffset.dy), false)
  })
  ipcMain.on('openpets:pet-drag-end', (e) => {
    if (!fromPet(e)) return
    dragging = false
    dragOffset = null
    petWindowDragging.set(currentPet!, false)
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

function installMotionStatePublisher(win: BrowserWindow): void {
  let lastX = win.getPosition()[0]
  let lastSent: PetMotionState = 'idle'
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const send = (state: PetMotionState): void => {
    if (win.isDestroyed() || lastSent === state) return
    lastSent = state
    win.webContents.send('openpets:pet-motion', state)
  }
  const scheduleIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      send('idle')
    }, 180)
  }
  const onMove = (): void => {
    if (win.isDestroyed()) return
    const [x] = win.getPosition()
    const dx = x - lastX
    lastX = x
    if (Math.abs(dx) >= 3) send(dx > 0 ? 'run-right' : 'run-left')
    scheduleIdle()
  }
  win.on('move', onMove)
  win.on('moved', onMove)
  win.webContents.on('did-finish-load', () => {
    lastSent = 'idle'
    if (!win.isDestroyed()) win.webContents.send('openpets:pet-motion', 'idle')
  })
  win.on('closed', () => {
    if (idleTimer) clearTimeout(idleTimer)
  })
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
  const sprite = `<div class="sprite" role="img" aria-label="纸壳助手桌宠"></div>`
  const bubble = bubbleText ? bubbleMarkup(bubbleText, reaction) : ''
  return `<div class="stage" aria-label="纸壳助手桌宠">
    ${bubble}
    <div class="pet-hitbox" aria-hidden="true"><div class="pet-shell">${sprite}</div></div>
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
  const reactionState = resolveReactionSpriteState(reaction, prefs.reactionOverrides)
  const spriteUrl = pathToFileURL(spriteAsset).toString()
  return `<!doctype html>
<html lang="zh-CN" data-reaction-state="${reactionState}" data-motion-state="idle">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>纸壳助手桌宠</title>
    <style>
      ${windowCss(prefs.paused, scale)}
      .sprite {
        width: ${defaultPetSprite.frameWidth}px;
        height: ${defaultPetSprite.frameHeight}px;
        background-image: url("${escapeCssUrl(spriteUrl)}");
        background-size: ${defaultPetSprite.frameWidth * defaultPetSprite.columns}px ${defaultPetSprite.frameHeight * defaultPetSprite.rows}px;
        background-repeat: no-repeat;
        --sprite-row-y: 0px;
        --sprite-frames: ${defaultPetSprite.states.idle.frames};
        --sprite-duration: ${defaultPetSprite.states.idle.durationMs}ms;
        --sprite-iterations: ${defaultPetSprite.states.idle.iterations};
        background-position: 0 var(--sprite-row-y);
        animation: pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations);
        animation-play-state: var(--play-state);
        transform: scale(${scale});
        transform-origin: top left;
      }
      ${spriteStateCss()}
      @keyframes pet-frames {
        from { background-position: 0 var(--sprite-row-y); }
        to { background-position: calc(-${defaultPetSprite.frameWidth}px * var(--sprite-frames)) var(--sprite-row-y); }
      }
    </style>
  </head>
  <body>
    ${bodyMarkup(reaction, bubbleText)}
  </body>
</html>`
}

function windowCss(paused: boolean, scale: PetScaleValue): string {
  const opacity = paused ? '0.62' : '1'
  const playState = paused ? 'paused' : 'running'
  const scaledWidth = Math.ceil(defaultPetSprite.frameWidth * scale)
  const scaledHeight = Math.ceil(defaultPetSprite.frameHeight * scale)
  const petBottom = 22
  const hitPadding = 18
  const bubbleBottom = Math.ceil(petBottom + scaledHeight + 8)
  return `
    :root { color-scheme: dark; --pet-opacity: ${opacity}; --play-state: ${playState}; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; user-select: none; -webkit-font-smoothing: antialiased; }
    html { color: #172033; }
    body { pointer-events: none; }
    .stage { width: 100%; height: 100%; position: relative; box-sizing: border-box; overflow: visible; }
    .pet-hitbox { position: absolute; left: 50%; bottom: ${Math.max(0, petBottom - hitPadding)}px; z-index: 1; width: ${scaledWidth + hitPadding * 2}px; height: ${scaledHeight + hitPadding * 2}px; display: grid; place-items: center; transform: translateX(-50%); pointer-events: auto; -webkit-app-region: no-drag; cursor: grab; }
    .pet-shell { position: relative; width: ${scaledWidth}px; height: ${scaledHeight}px; display: block; opacity: var(--pet-opacity); filter: drop-shadow(0 10px 12px rgba(15, 23, 42, 0.24)) drop-shadow(0 2px 3px rgba(15, 23, 42, 0.18)); transition: opacity 180ms cubic-bezier(0.2, 0, 0, 1); pointer-events: auto; -webkit-app-region: no-drag; cursor: grab; }
    .bubble { position: absolute; left: 50%; bottom: ${bubbleBottom}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 80px; max-width: min(220px, calc(100vw - 18px)); padding: 9px 12px; background: linear-gradient(135deg, rgba(255, 247, 237, 0.98), rgba(254, 243, 226, 0.96)); color: #2a2117; font: 700 12px/16px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; text-align: left; border: 1px solid rgba(255, 255, 255, 0.78); border-radius: 14px; box-shadow: 0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12); white-space: normal; overflow-wrap: break-word; pointer-events: auto; -webkit-app-region: no-drag; transform: translateX(-50%); transform-origin: 64% 100%; animation: bubble-in 180ms cubic-bezier(0.2, 0, 0, 1); }
    .bubble::after { content: ""; position: absolute; left: 64%; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid rgba(255, 255, 255, 0.56); border-bottom: 1px solid rgba(255, 255, 255, 0.56); border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg); }
    .bubble-text { display: -webkit-box; min-width: 0; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow-wrap: break-word; }
    .bubble.is-success { border-color: rgba(16, 185, 129, 0.4); }
    .bubble.is-error { border-color: rgba(239, 68, 68, 0.4); }
    .bubble.is-waiting { border-color: rgba(245, 158, 11, 0.45); }
    .bubble.is-busy { border-color: rgba(59, 130, 246, 0.4); }
    .bubble.is-info { border-color: rgba(56, 189, 248, 0.4); }
    @keyframes bubble-in { from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
    @media (prefers-reduced-motion: reduce) { .sprite, .bubble { animation: none !important; } }
  `
}

function spriteStateCss(): string {
  const reactionRules = (Object.keys(defaultPetSprite.states) as UniversalSpriteState[]).map((state) =>
    spriteRule(`html[data-reaction-state="${state}"] .sprite`, state)
  )
  const motionRules = (Object.entries(motionToSpriteState) as Array<[PetMotionState, UniversalSpriteState]>)
    .filter(([motion]) => motion !== 'idle')
    .map(([motion, state]) => spriteRule(`html[data-motion-state="${motion}"] .sprite`, state))
  return [...reactionRules, ...motionRules].join('\n')
}

function spriteRule(selector: string, state: UniversalSpriteState): string {
  const row = defaultPetSprite.states[state]
  const iterations = 'iterations' in row ? row.iterations : 'infinite'
  return `${selector} { --sprite-row-y: -${row.row * defaultPetSprite.frameHeight}px; --sprite-frames: ${row.frames}; --sprite-duration: ${row.durationMs}ms; --sprite-iterations: ${iterations}; }`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeCssUrl(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}
