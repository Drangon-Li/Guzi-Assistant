import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

// 仿 quickaction.ts 的内嵌脚本模式：Swift 源码内嵌，首次用时编译缓存
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
  let lines = (request.results ?? []).compactMap {
    ($0 as? VNRecognizedTextObservation)?.topCandidates(1).first?.string
  }
  print(lines.joined(separator: "\\n"))
} catch {
  FileHandle.standardError.write("ocr failed: \\(error)\\n".data(using: .utf8)!)
  exit(4)
}
`

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

let ensured: Promise<string> | null = null

/** 返回编译好的 vision-ocr 路径；不存在则用 swiftc 现编译并缓存 */
async function ensureOcrBinary(): Promise<string> {
  const bin = join(binDir(), 'vision-ocr')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'vision-ocr.swift')
  writeFileSync(src, SWIFT_SRC)
  try {
    await execFileAsync('swiftc', ['-O', '-o', bin, src])
  } catch {
    throw new Error('本地 OCR 初始化失败：需要 Xcode 命令行工具（请运行 xcode-select --install）')
  }
  return bin
}

/** 对 png 做本地 Apple Vision OCR，返回逐行拼接的文字 */
export async function ocrImage(pngPath: string): Promise<string> {
  // 编译失败时重置，下次重试；成功后缓存 Promise 避免重复编译
  if (!ensured)
    ensured = ensureOcrBinary().catch((e) => {
      ensured = null
      throw e
    })
  const bin = await ensured
  const { stdout } = await execFileAsync(bin, [pngPath], { maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}
