/**
 * 截图加密金库（#52 图像持久化 + #53 落盘加密）。
 *
 * 落盘截图是隐私高敏资产 → **at-rest 加密**：用 Electron `safeStorage`（底层走系统钥匙串，
 * 比引第三方 keyring 轻，守做减法）。加密不可用则**不落盘**（宁缺毋明文）。
 * 仅缩略图（≤480w），不存原图。键管理：safeStorage 透明用 OS 凭据，无需自管密钥。
 *
 * 流程：监控/扫描时按 textHash 存「临时」加密缩略图 → 用户接受建议后 finalize 到 sourceId；
 * 未接受的临时文件由 sweep 按 mtime 清。保留期清理见 shot-retention（纯计算）。
 */
import { app, nativeImage, safeStorage } from 'electron'
import type { NativeImage } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

function dir(): string {
  return join(app.getPath('userData'), 'shots')
}

/** safeStorage 是否可用（无钥匙串/headless 时 false → 不落盘） */
export function isShotVaultReady(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 图像 → 缩略图(≤480w) → 加密落盘到临时键。加密不可用/失败 → 不落盘返 false。 */
export function saveShotTempFromImage(key: string, img: NativeImage): boolean {
  if (!isShotVaultReady()) return false
  try {
    if (img.isEmpty()) return false
    const w = img.getSize().width
    const thumb = w > 480 ? img.resize({ width: 480 }) : img
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), `tmp-${key}.enc`), safeStorage.encryptString(thumb.toDataURL()))
    return true
  } catch {
    return false
  }
}

/** 截图 png 路径 → 加密落盘临时键(整屏，证据裁剪走 saveShotTempFromImage)。 */
export function saveShotTempFromPng(key: string, pngPath: string): boolean {
  return saveShotTempFromImage(key, nativeImage.createFromPath(pngPath))
}

/** 接受建议后把临时截图落实到 sourceId；无临时文件则 no-op 返 false。 */
export function finalizeShot(key: string, sourceId: string): boolean {
  try {
    const tmp = join(dir(), `tmp-${key}.enc`)
    if (!existsSync(tmp)) return false
    renameSync(tmp, join(dir(), `${sourceId}.enc`))
    return true
  } catch {
    return false
  }
}

/** 读出并解密缩略图为 dataURL；无/失败返 null。 */
export function readShotDataUrl(sourceId: string): string | null {
  try {
    const p = join(dir(), `${sourceId}.enc`)
    if (!existsSync(p)) return null
    return safeStorage.decryptString(readFileSync(p))
  } catch {
    return null
  }
}

export function deleteShot(sourceId: string): void {
  try {
    const p = join(dir(), `${sourceId}.enc`)
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/** 已落实截图的 sourceId 列表（保留期清理用）。 */
export function listShotIds(): string[] {
  try {
    return readdirSync(dir())
      .filter((f) => f.endsWith('.enc') && !f.startsWith('tmp-'))
      .map((f) => f.slice(0, -4))
  } catch {
    return []
  }
}

/** 一键清除：删掉所有加密截图（含临时），用于「清除全部数据」。 */
export function clearAllShots(): void {
  try {
    for (const f of readdirSync(dir())) {
      if (f.endsWith('.enc')) {
        try {
          unlinkSync(join(dir(), f))
        } catch {
          /* ignore one file */
        }
      }
    }
  } catch {
    /* dir 不存在等 */
  }
}

/** 清掉超过 maxAgeMs 的未接受临时截图（按 mtime）。 */
export function sweepTempShots(maxAgeMs: number, nowMs: number): void {
  try {
    for (const f of readdirSync(dir())) {
      if (!f.startsWith('tmp-')) continue
      const p = join(dir(), f)
      try {
        if (nowMs - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p)
      } catch {
        /* ignore one file */
      }
    }
  } catch {
    /* dir 不存在等 */
  }
}
