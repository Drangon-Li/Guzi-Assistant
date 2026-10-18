import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import type { TextBox } from '@shared/chat-layout'

const execFileAsync = promisify(execFile)

// 仿 quickaction.ts 的内嵌脚本模式：Swift 源码内嵌，首次用时编译缓存。
// #54：输出 JSON（每行文字 + 归一化 box 坐标），用于聊天「谁说的」版面归属。
// Vision boundingBox 原点在左下、归一化 → 转成左上原点的 {x,y,w,h}。
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

/** 返回编译好的 vision-ocr 路径；不存在则用 swiftc 现编译并缓存。
 *  改名 v2：输出从纯文本换成 JSON，旧缓存二进制不可复用，换名强制重编。 */
async function ensureOcrBinary(): Promise<string> {
  const bin = join(binDir(), 'vision-ocr-v2')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'vision-ocr-v2.swift')
  writeFileSync(src, SWIFT_SRC)
  try {
    await execFileAsync('swiftc', ['-O', '-o', bin, src], { timeout: 60_000 })
  } catch {
    throw new Error('本地 OCR 初始化失败：需要 Xcode 命令行工具（请运行 xcode-select --install）')
  }
  return bin
}

/** 对 png 做本地 Apple Vision OCR，返回每行文字 + 归一化 box 坐标。 */
export async function ocrImageDetailed(pngPath: string, signal?: AbortSignal): Promise<TextBox[]> {
  signal?.throwIfAborted()
  // 已缓存的二进制若被删除（升级覆盖 userData / 清理工具），重置缓存触发重新编译
  if (ensured && !existsSync(await ensured.catch(() => ''))) ensured = null
  // 编译失败时重置，下次重试；成功后缓存 Promise 避免重复编译
  if (!ensured)
    ensured = ensureOcrBinary().catch((e) => {
      ensured = null
      throw e
    })
  const bin = await ensured
  signal?.throwIfAborted()
  const { stdout } = await execFileAsync(bin, [pngPath], { maxBuffer: 10 * 1024 * 1024, timeout: 20_000, signal })
  const raw = stdout.trim()
  if (!raw) throw new Error('本地 OCR 返回空响应')
  try {
    const arr = JSON.parse(raw) as Array<Partial<TextBox>>
    if (!Array.isArray(arr)) throw new Error('本地 OCR 返回格式无效')
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
    throw new Error('本地 OCR 返回格式无效')
  }
}

/** 对 png 做本地 Apple Vision OCR，返回逐行拼接的文字（兼容旧调用方）。 */
export async function ocrImage(pngPath: string): Promise<string> {
  return (await ocrImageDetailed(pngPath)).map((b) => b.text).join('\n')
}
