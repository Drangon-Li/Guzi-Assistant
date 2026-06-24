// 桌宠运动纯数学（零依赖、无副作用，可 headless 单测）。移植自 openpets pet-motion-engine.ts（MIT）。

export function easeProgress(t: number, easing: string): number {
  if (easing === 'linear') return t
  if (easing === 'ease-in') return t * t
  if (easing === 'ease-out') return 1 - (1 - t) * (1 - t)
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 // ease-in-out
}

// 重力地板 y：工作区底 - 桌宠高（终端约束已移除）。
export function computeGravityFloor(workAreaY: number, workAreaHeight: number, petHeight: number): number {
  return workAreaY + workAreaHeight - petHeight
}
