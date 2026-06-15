/**
 * 屏幕监控（#40）的纯函数核心：感知哈希（dhash）+ 汉明距离 + 文本哈希。
 * 主进程在 screenwatch.ts 里用 Electron nativeImage 取灰度像素后调 dhash，
 * 这里只做纯计算，便于单测。
 */

/**
 * dhash：对 width×height 的灰度数组（行优先），每行比较相邻像素，
 * 左 < 右 记 1。width=9,height=8 → 8×8=64 bit，返回 bigint 位图。
 */
export function dhash(gray: number[], width: number, height: number): bigint {
  let bits = 0n
  let bit = 0n
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = gray[y * width + x]
      const right = gray[y * width + x + 1]
      if (left < right) bits |= 1n << bit
      bit++
    }
  }
  return bits
}

/** 两个哈希的汉明距离（不同 bit 数） */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

/** BGRA 像素缓冲（Electron toBitmap 输出）→ 灰度数组（Rec.601 加权） */
export function bgraToGray(bgra: ArrayLike<number>, width: number, height: number): number[] {
  const gray: number[] = new Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const b = bgra[i * 4]
    const g = bgra[i * 4 + 1]
    const r = bgra[i * 4 + 2]
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000
  }
  return gray
}

/** 归一化文本哈希（折叠空白后 djb2），用于「OCR 文本是否变化」的二次去重 */
export function textHash(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return String(h >>> 0)
}
