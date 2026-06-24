// 移植自 openpets pet-motion-engine.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
// 改动：去掉终端约束（confinement）；isPetWindowDragging 改注入式（避免打包后运行时 require './pet-window'）；
// electron 用全局 require 懒加载（单测经 _setScreenForTesting 注入、不触发）。单写者 + 16ms 共享 ticker 保留。

import type { BrowserWindow } from 'electron'
import {
  clampToNearestDisplayIfOffscreen,
  clampToVisibleWorkArea,
  defaultPetWindowSize,
  isCrossDisplayRoamingEnabled,
  type Point
} from './display'
import { computeGravityFloor, easeProgress } from './motion-math'

// 纯数学拆到 motion-math（便于 headless 单测）；此处再导出保持调用面不变。
export { computeGravityFloor, easeProgress } from './motion-math'

interface ScreenImpl {
  getCursorScreenPoint(): { x: number; y: number }
  getDisplayNearestPoint(point: { x: number; y: number }): {
    workArea: { x: number; y: number; width: number; height: number }
  }
}
type IsPetWindowDraggingFn = (win: BrowserWindow) => boolean

let _screen: ScreenImpl | null = null
function getScreen(): ScreenImpl {
  if (!_screen) {
    const { screen } = require('electron') as { screen: ScreenImpl }
    _screen = screen
  }
  return _screen
}
export function _setScreenForTesting(impl: ScreenImpl | null): void {
  _screen = impl
}

// 拖拽判定注入式：pet-window 初始化时 setIsPetWindowDragging(...)；未注入时默认「不在拖拽」。
let _isPetWindowDragging: IsPetWindowDraggingFn = () => false
export function setIsPetWindowDragging(fn: IsPetWindowDraggingFn): void {
  _isPetWindowDragging = fn
}
export function _setIsPetWindowDraggingForTesting(fn: IsPetWindowDraggingFn | null): void {
  _isPetWindowDragging = fn ?? (() => false)
}

export function _sharedTickerActiveForTesting(): boolean {
  return sharedTicker !== null
}
export function _resetMotionStatesForTesting(): void {
  motionStates.clear()
  stopSharedTicker()
}
export function _getPhysicsForTesting(petHandleId: string): { gravity: boolean; bounce: number; vy: number } | null {
  return motionStates.get(petHandleId)?.state.physics ?? null
}

export type WindowAccessor = () => BrowserWindow | null

type MotionState = {
  follow: { lag: number } | null
  physics: { gravity: boolean; bounce: number; vy: number } | null
  loop: ReturnType<typeof setInterval> | null
  moveGeneration: number
  moveTarget: {
    x: number
    y: number
    startX: number
    startY: number
    elapsed: number
    durationMs: number
    easing: string
  } | null
  fracX: number
  fracY: number
}

const motionStates = new Map<string, { accessor: WindowAccessor; state: MotionState }>()
const loopIntervalMs = 16

let sharedTicker: ReturnType<typeof setInterval> | null = null

function startSharedTicker(): void {
  if (sharedTicker) return
  sharedTicker = setInterval(tickAll, loopIntervalMs)
  sharedTicker.unref?.()
}
function stopSharedTicker(): void {
  if (sharedTicker) {
    clearInterval(sharedTicker)
    sharedTicker = null
  }
}

function tickAll(): void {
  for (const [petHandleId, { accessor, state }] of motionStates) {
    if (state.follow === null && state.physics === null) continue
    tickPet(petHandleId, accessor, state)
  }
  if ([...motionStates.values()].every((e) => e.state.follow === null && e.state.physics === null)) {
    stopSharedTicker()
  }
}

function stateFor(petHandleId: string, accessor: WindowAccessor): MotionState {
  let entry = motionStates.get(petHandleId)
  if (!entry) {
    entry = {
      accessor,
      state: { follow: null, physics: null, loop: null, moveGeneration: 0, moveTarget: null, fracX: 0, fracY: 0 }
    }
    motionStates.set(petHandleId, entry)
  }
  entry.accessor = accessor
  return entry.state
}

export function registerPet(petHandleId: string, accessor: WindowAccessor): void {
  stateFor(petHandleId, accessor)
}

export function unregisterPet(petHandleId: string): void {
  motionStop(petHandleId)
  motionStates.delete(petHandleId)
  if ([...motionStates.values()].every((e) => e.state.follow === null && e.state.physics === null)) {
    stopSharedTicker()
  }
}

export async function motionMoveTo(
  petHandleId: string,
  accessor: WindowAccessor,
  target: Point,
  opts: { durationMs?: number; easing?: string } = {}
): Promise<void> {
  const state = stateFor(petHandleId, accessor)
  const window = accessor()
  if (!window || window.isDestroyed()) return
  const generation = ++state.moveGeneration
  const durationMs = Math.min(Math.max(opts.durationMs ?? 700, 100), 10_000)
  const easing = opts.easing ?? 'ease-in-out'

  if (state.follow !== null || state.physics !== null) {
    const [startX, startY] = window.getPosition()
    const clamped = clampPosition(petHandleId, target)
    state.moveTarget = { x: clamped.x, y: clamped.y, startX, startY, elapsed: 0, durationMs, easing }
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (state.moveGeneration !== generation || state.moveTarget === null) {
          resolve()
          return
        }
        setTimeout(check, loopIntervalMs * 2).unref?.()
      }
      check()
    })
  }

  const [startX, startY] = window.getPosition()
  const clamped = clampPosition(petHandleId, target)
  const steps = Math.max(4, Math.round(durationMs / 33))
  for (let step = 1; step <= steps; step += 1) {
    const live = accessor()
    if (!live || live.isDestroyed() || state.moveGeneration !== generation || _isPetWindowDragging(live)) return
    const t = easeProgress(step / steps, easing)
    live.setPosition(Math.round(startX + (clamped.x - startX) * t), Math.round(startY + (clamped.y - startY) * t), false)
    await delay(durationMs / steps)
  }
}

export function motionSetFollowCursor(
  petHandleId: string,
  accessor: WindowAccessor,
  opts: { enabled: boolean; lag?: number }
): void {
  const state = stateFor(petHandleId, accessor)
  state.follow = opts.enabled ? { lag: Math.min(Math.max(opts.lag ?? 0.85, 0), 1) } : null
  syncLoop(state)
}

export function motionSetPhysics(
  petHandleId: string,
  accessor: WindowAccessor,
  opts: { gravity?: boolean; bounce?: number }
): void {
  const state = stateFor(petHandleId, accessor)
  state.physics = opts.gravity ? { gravity: true, bounce: Math.min(Math.max(opts.bounce ?? 0.4, 0), 1), vy: 0 } : null
  syncLoop(state)
}

export function motionStop(petHandleId: string): void {
  const entry = motionStates.get(petHandleId)
  if (!entry) return
  entry.state.follow = null
  entry.state.physics = null
  entry.state.moveGeneration += 1
  entry.state.moveTarget = null
  entry.state.fracX = 0
  entry.state.fracY = 0
  if (entry.state.loop) {
    clearInterval(entry.state.loop)
    entry.state.loop = null
  }
}

export function motionStopAll(): void {
  for (const petHandleId of motionStates.keys()) motionStop(petHandleId)
}

function syncLoop(state: MotionState): void {
  const wantsLoop = state.follow !== null || state.physics !== null
  if (!wantsLoop) {
    if (state.loop) {
      clearInterval(state.loop)
      state.loop = null
    }
    return
  }
  if (state.loop) {
    clearInterval(state.loop)
    state.loop = null
  }
  startSharedTicker()
}

function tickPet(petHandleId: string, accessor: WindowAccessor, state: MotionState): void {
  const window = accessor()
  if (!window || window.isDestroyed()) {
    unregisterPet(petHandleId)
    return
  }
  if (!window.isVisible() || _isPetWindowDragging(window)) {
    if (state.moveTarget) {
      state.moveTarget.elapsed += loopIntervalMs
      if (state.moveTarget.elapsed >= state.moveTarget.durationMs) {
        state.moveTarget = null
        state.moveGeneration += 1
      }
    }
    return
  }
  const [x, y] = window.getPosition()
  let rawX = x + state.fracX
  let rawY = y + state.fracY

  if (state.follow) {
    const cursor = getScreen().getCursorScreenPoint()
    const targetX = cursor.x - Math.round(defaultPetWindowSize.width / 2)
    const targetY = cursor.y - Math.round(defaultPetWindowSize.height * 0.7)
    const smoothing = 1 - state.follow.lag
    const factor = Math.max(0.02, smoothing * 0.35)
    rawX += (targetX - rawX) * factor
    rawY += (targetY - rawY) * factor
  }

  if (state.moveTarget) {
    state.moveTarget.elapsed += loopIntervalMs
    const progress = Math.min(state.moveTarget.elapsed / state.moveTarget.durationMs, 1)
    const t = easeProgress(progress, state.moveTarget.easing)
    rawX = state.moveTarget.startX + (state.moveTarget.x - state.moveTarget.startX) * t
    if (!state.physics) {
      rawY = state.moveTarget.startY + (state.moveTarget.y - state.moveTarget.startY) * t
    }
    if (progress >= 1) {
      state.moveTarget = null
      state.moveGeneration += 1
    }
  }

  if (state.physics?.gravity) {
    const bottomCenterX = x + Math.round(defaultPetWindowSize.width / 2)
    const bottomCenterY = y + defaultPetWindowSize.height
    const display = getScreen().getDisplayNearestPoint({ x: bottomCenterX, y: bottomCenterY })
    const floor = computeGravityFloor(display.workArea.y, display.workArea.height, defaultPetWindowSize.height)
    state.physics.vy = Math.min(state.physics.vy + 2.2, 48)
    rawY = y + state.physics.vy
    if (rawY >= floor) {
      rawY = floor
      if (Math.abs(state.physics.vy) > 6 && state.physics.bounce > 0) state.physics.vy = -state.physics.vy * state.physics.bounce
      else state.physics.vy = 0
    }
  }

  const nextX = Math.round(rawX)
  const nextY = Math.round(rawY)
  state.fracX = rawX - nextX
  state.fracY = rawY - nextY

  if (nextX !== x || nextY !== y) {
    const clamped = clampPosition(petHandleId, { x: nextX, y: nextY })
    window.setPosition(clamped.x, clamped.y, false)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 去终端约束后：跨显示器漫游开 → 离屏吸附；否则单显示器 clamp。
function clampPosition(_petHandleId: string, pos: Point): Point {
  if (isCrossDisplayRoamingEnabled()) return clampToNearestDisplayIfOffscreen(pos, defaultPetWindowSize)
  return clampToVisibleWorkArea(pos, defaultPetWindowSize)
}

export function _clampPositionForTesting(petHandleId: string, pos: Point): Point {
  return clampPosition(petHandleId, pos)
}
