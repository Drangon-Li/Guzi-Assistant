import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

// 仿 ocr.ts 的内嵌 Swift 模式：NSWorkspace 读前台 App 的本地化名称。
// 选 NSWorkspace 而非 osascript(System Events)：前者读 frontmostApplication 无需任何权限，
// 后者会弹「自动化」授权框，对一个隐私辅助功能是过重的摩擦。
const SWIFT_SRC = `import AppKit
print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "")
`

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

let ensured: Promise<string> | null = null

async function ensureBinary(): Promise<string> {
  const bin = join(binDir(), 'frontmost-app')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'frontmost-app.swift')
  writeFileSync(src, SWIFT_SRC)
  await execFileAsync('swiftc', ['-O', '-o', bin, src])
  return bin
}

/**
 * 当前前台 App 的本地化名称；失败一律返 null。
 * fail-open：检测不到（无 swiftc / 非 macOS / 异常）时返 null → 排除门放行、监控照常，
 * 排除名单是「尽力而为」的便利项而非硬安全边界（整功能 opt-in 且 macOS 强制显示录制指示器）。
 */
export async function getFrontmostApp(): Promise<string | null> {
  try {
    if (ensured && !existsSync(await ensured.catch(() => ''))) ensured = null
    if (!ensured)
      ensured = ensureBinary().catch((e) => {
        ensured = null
        throw e
      })
    const bin = await ensured
    const { stdout } = await execFileAsync(bin, [], { timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}
