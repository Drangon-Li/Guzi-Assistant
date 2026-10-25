export interface CaptureRect { x: number; y: number; width: number; height: number }

export function selectionRect(a: { x: number; y: number }, b: { x: number; y: number }): CaptureRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export function intersectRect(a: CaptureRect, b: CaptureRect): CaptureRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** Map display-local DIP edges to the actual thumbnail, including negative-origin displays. */
export function thumbnailCrop(selection: CaptureRect, display: CaptureRect, pixels: { width: number; height: number }): CaptureRect | null {
  const overlap = intersectRect(selection, display)
  if (!overlap) return null
  const x = Math.round((overlap.x - display.x) * pixels.width / display.width)
  const y = Math.round((overlap.y - display.y) * pixels.height / display.height)
  const right = Math.round((overlap.x + overlap.width - display.x) * pixels.width / display.width)
  const bottom = Math.round((overlap.y + overlap.height - display.y) * pixels.height / display.height)
  return { x, y, width: right - x, height: bottom - y }
}

