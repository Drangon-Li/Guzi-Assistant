import type { TextBox } from '../../shared/chat-layout.ts'

export interface OcrDetectionResult {
  texts: Array<{ text: string; box: Array<[number, number]> }>
  resizedImageWidth: number
  resizedImageHeight: number
}

export function normalizeOcrResult(result: OcrDetectionResult): TextBox[] {
  const { resizedImageWidth: width, resizedImageHeight: height, texts } = result
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Array.isArray(texts)) {
    throw new Error('本地 OCR 返回格式无效')
  }
  return texts.flatMap((line) => {
    if (!line || typeof line.text !== 'string' || !line.text.trim() || !Array.isArray(line.box) || line.box.length !== 4) return []
    if (!line.box.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return []
    const left = Math.min(...line.box.map((point) => point[0])), top = Math.min(...line.box.map((point) => point[1]))
    const w = Math.max(...line.box.map((point) => point[0])) - left, h = Math.max(...line.box.map((point) => point[1])) - top
    if (w <= 0 || h <= 0) return []
    const x = Math.max(0, Math.min(1, left / width)), y = Math.max(0, Math.min(1, top / height))
    const right = Math.max(0, Math.min(1, (left + w) / width)), bottom = Math.max(0, Math.min(1, (top + h) / height))
    return right > x && bottom > y ? [{ text: line.text, x, y, w: right - x, h: bottom - y }] : []
  })
}
