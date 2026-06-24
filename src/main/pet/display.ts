// 移植自 openpets display.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
// 改动：内联 deriveDisplayKey（去 app-state-core 依赖）；electron 用全局 require 懒加载（CJS main 可用，
// 单测经 _setScreenForTesting 注入、不触发 require）。clamp/可见性逻辑保留。

import type { Rectangle } from 'electron'

export interface Point {
  readonly x: number
  readonly y: number
}
export interface WindowSize {
  readonly width: number
  readonly height: number
}

// 显示器 ID 在某些平台重启会变，改用物理几何作稳定键。
function deriveDisplayKey(bounds: { x: number; y: number; width: number; height: number }): string {
  return `${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`
}

export function getDisplayKey(bounds: Rectangle): string {
  return deriveDisplayKey(bounds)
}

export const defaultPetWindowSize: WindowSize = { width: 340, height: 420 }
export const defaultPetWindowMargin = 24

// 每轴最小重叠像素：判定桌宠是否"还在某显示器上"，挡掉发丝级残留又允许跨缝穿行。
const MIN_VISIBLE_PX = 100

export interface DisplayInfo {
  bounds: Rectangle
  workArea: Rectangle
}
export interface ScreenImpl {
  getAllDisplays(): DisplayInfo[]
  getPrimaryDisplay(): DisplayInfo
  getDisplayNearestPoint(point: { x: number; y: number }): DisplayInfo
}

let _screen: ScreenImpl | null = null

function getScreen(): ScreenImpl {
  if (!_screen) {
    const { screen } = require('electron') as { screen: ScreenImpl }
    _screen = screen
  }
  return _screen
}

/** 仅供单测注入 mock screen；传 null 恢复真实 electron。 */
export function _setScreenForTesting(impl: ScreenImpl | null): void {
  _screen = impl
  _cachedDisplays = null
}

let _cachedDisplays: DisplayInfo[] | null = null

/** 显示器拓扑事件（增/删/metrics-changed）时调用以失效缓存。 */
export function invalidateDisplayCache(): void {
  _cachedDisplays = null
}

function getAllDisplaysCached(): DisplayInfo[] {
  if (!_cachedDisplays) _cachedDisplays = getScreen().getAllDisplays()
  return _cachedDisplays
}

export function getDisplayKeyForPosition(position: Point, size: WindowSize = defaultPetWindowSize): string {
  const centre = { x: position.x + size.width / 2, y: position.y + size.height / 2 }
  return getDisplayKey(getScreen().getDisplayNearestPoint(centre).bounds)
}

export function getAllDisplayKeys(): string[] {
  return getScreen()
    .getAllDisplays()
    .map((d) => getDisplayKey(d.bounds))
}

export function getDefaultPetInitialPosition(size: WindowSize = defaultPetWindowSize): Point {
  const { workArea } = getScreen().getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - size.width - defaultPetWindowMargin),
    y: Math.round(workArea.y + workArea.height - size.height - defaultPetWindowMargin)
  }
}

/** 桌宠是否仍与某显示器工作区在两轴上各重叠 ≥ minOverlap。底部中点锚（可见 sprite 在窗口底部）。 */
export function isOnAnyDisplay(
  position: Point,
  width: number,
  height: number,
  minOverlap: number = MIN_VISIBLE_PX
): boolean {
  const anchorX = position.x + width / 2
  const anchorY = position.y + height
  for (const display of getAllDisplaysCached()) {
    const wa = display.workArea
    if (anchorX >= wa.x && anchorX <= wa.x + wa.width && anchorY >= wa.y && anchorY <= wa.y + wa.height) {
      return true
    }
    const overlapX = Math.min(position.x + width, wa.x + wa.width) - Math.max(position.x, wa.x)
    const overlapY = Math.min(position.y + height, wa.y + wa.height) - Math.max(position.y, wa.y)
    if (overlapX >= minOverlap && overlapY >= minOverlap) return true
  }
  return false
}

function clampIntoWorkArea(
  position: Point,
  size: WindowSize,
  workArea: { x: number; y: number; width: number; height: number }
): Point {
  const minX = workArea.x
  const minY = workArea.y
  const maxX = workArea.x + Math.max(0, workArea.width - size.width)
  const maxY = workArea.y + Math.max(0, workArea.height - size.height)
  return { x: clamp(Math.round(position.x), minX, maxX), y: clamp(Math.round(position.y), minY, maxY) }
}

/** 宽松containment：仍可见则原样返回；完全离屏才吸附到最近显示器。 */
export function clampToNearestDisplayIfOffscreen(position: Point, size: WindowSize = defaultPetWindowSize): Point {
  if (isOnAnyDisplay(position, size.width, size.height)) {
    return { x: Math.round(position.x), y: Math.round(position.y) }
  }
  const anchor = { x: Math.round(position.x + size.width / 2), y: Math.round(position.y + size.height) }
  const { workArea } = getScreen().getDisplayNearestPoint(anchor)
  return clampIntoWorkArea(position, size, workArea)
}

/** 单显示器 clamp（跨显示器漫游关闭时用）。 */
export function clampToVisibleWorkArea(position: Point, size: WindowSize = defaultPetWindowSize): Point {
  const centre = { x: position.x + size.width / 2, y: position.y + size.height / 2 }
  const { workArea } = getScreen().getDisplayNearestPoint(centre)
  return clampIntoWorkArea(position, size, workArea)
}

let _crossDisplayRoamingEnabled = false
export function setCrossDisplayRoamingEnabled(enabled: boolean): void {
  _crossDisplayRoamingEnabled = enabled
}
export function isCrossDisplayRoamingEnabled(): boolean {
  return _crossDisplayRoamingEnabled
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
