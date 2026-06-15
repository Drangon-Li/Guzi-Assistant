import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import type { TextBox } from '@shared/chat-layout'

const execFileAsync = promisify(execFile)

/**
 * 屏幕 OCR / 视觉解析 —— 跨平台。
 * - 托管视觉 API（RapidOCR/PP-OCR，部署在我方 GPU 机）：设 `ESHELL_OCR_API` 即启用，跨平台（Linux/Win/Mac）。
 * - macOS 本地 Apple Vision（on-device、隐私不外传）：未配置 API 时在 mac 上用它兜底。
 * 二者输出同形：每行文字 + 归一化 box（左上原点 0-1），供 #54/#60 聊天版面归属与关键词门用。
 */

// ── 托管视觉 API（跨平台主路径）─────────────────────────────────────────────
/** 我方托管视觉 API base（公网暴露后可内置默认值；现支持 env / 设置注入）。 */
function ocrApiUrl(): string {
  return (process.env.ESHELL_OCR_API ?? '').replace(/\/$/, '')
}

async function ocrViaApi(pngPath: string): Promise<TextBox[]> {
  const base = ocrApiUrl()
  const b64 = readFileSync(pngPath).toString('base64')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${base}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64 }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`视觉服务返回 ${res.status}`)
    const data = (await res.json()) as { blocks?: Array<Partial<TextBox>> }
    return (data.blocks ?? [])
      .filter((b) => b && typeof b.text === 'string')
      .map((b) => ({
        text: b.text as string,
        x: Number(b.x) || 0,
        y: Number(b.y) || 0,
        w: Number(b.w) || 0,
        h: Number(b.h) || 0
      }))
  } finally {
    clearTimeout(timer)
  }
}

// ── macOS 本地 Apple Vision（隐私兜底）──────────────────────────────────────
// 内嵌 Swift，首次用时编译缓存。Vision boundingBox 原点在左下、归一化 → 转左上 {x,y,w,h}。
const SWIFT_SRC = `import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
  FileHandle.standardError.write("usage: vision-ocr <image>\\n".data(using: .utf8)!)
  exit(2)
}
guard let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load image\\n".data(using: .utf8)!)
  exit(3)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
  var items: [[String: Any]] = []
  for obs in (request.results ?? []) {
    guard let o = obs as? VNRecognizedTextObservation,
          let s = o.topCandidates(1).first?.string else { continue }
    let b = o.boundingBox
    items.append(["text": s, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height])
  }
  let data = try JSONSerialization.data(withJSONObject: items, options: [])
  print(String(data: data, encoding: .utf8) ?? "[]")
} catch {
  FileHandle.standardError.write("ocr failed: \\(error)\\n".data(using: .utf8)!)
  exit(4)
}
`

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

let ensured: Promise<string> | null = null

async function ensureOcrBinary(): Promise<string> {
  const bin = join(binDir(), 'vision-ocr-v2')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'vision-ocr-v2.swift')
  writeFileSync(src, SWIFT_SRC)
  try {
    await execFileAsync('swiftc', ['-O', '-o', bin, src])
  } catch {
    throw new Error('本地 OCR 初始化失败：需要 Xcode 命令行工具（请运行 xcode-select --install）')
  }
  return bin
}

async function ocrViaVision(pngPath: string): Promise<TextBox[]> {
  if (ensured && !existsSync(await ensured.catch(() => ''))) ensured = null
  if (!ensured)
    ensured = ensureOcrBinary().catch((e) => {
      ensured = null
      throw e
    })
  const bin = await ensured
  const { stdout } = await execFileAsync(bin, [pngPath], { maxBuffer: 10 * 1024 * 1024 })
  const raw = stdout.trim()
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as Array<Partial<TextBox>>
    return arr
      .filter((b) => b && typeof b.text === 'string')
      .map((b) => ({
        text: b.text as string,
        x: Number(b.x) || 0,
        y: Number(b.y) || 0,
        w: Number(b.w) || 0,
        h: Number(b.h) || 0
      }))
  } catch {
    return []
  }
}

// ── 派发 ────────────────────────────────────────────────────────────────────
/** 对 png 做 OCR，返回每行文字 + 归一化 box。优先托管视觉 API，mac 无 API 时回退本地 Vision。 */
export async function ocrImageDetailed(pngPath: string): Promise<TextBox[]> {
  if (ocrApiUrl()) return ocrViaApi(pngPath)
  if (process.platform === 'darwin') return ocrViaVision(pngPath)
  throw new Error('视觉解析未配置：请设置 ESHELL_OCR_API（或在 macOS 上使用本地视觉）')
}

/** 逐行拼接的文字（兼容旧调用方）。 */
export async function ocrImage(pngPath: string): Promise<string> {
  return (await ocrImageDetailed(pngPath)).map((b) => b.text).join('\n')
}
