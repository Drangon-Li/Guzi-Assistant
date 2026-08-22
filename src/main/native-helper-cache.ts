import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface NativeHelperBuildOptions {
  directory: string
  binaryName: string
  source: string
  compile: (sourcePath: string, outputPath: string) => Promise<void>
}

export function nativeHelperSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export function nativeHelperCacheIsCurrent(
  binaryPath: string,
  markerPath: string,
  expectedHash: string
): boolean {
  if (!existsSync(binaryPath)) return false
  try {
    return readFileSync(markerPath, 'utf8').trim() === expectedHash
  } catch {
    return false
  }
}

/** Compile a helper only when its source marker is missing or stale. */
export async function ensureNativeHelperBinary(options: NativeHelperBuildOptions): Promise<string> {
  const binaryPath = join(options.directory, options.binaryName)
  const markerPath = `${binaryPath}.sha256`
  const expectedHash = nativeHelperSourceHash(options.source)
  if (nativeHelperCacheIsCurrent(binaryPath, markerPath, expectedHash)) return binaryPath

  mkdirSync(options.directory, { recursive: true })
  const sourcePath = join(options.directory, `${options.binaryName}.m`)
  const temporaryBinaryPath = join(options.directory, `.${options.binaryName}.${process.pid}.${randomUUID()}.tmp`)
  writeFileSync(sourcePath, options.source)
  try {
    await options.compile(sourcePath, temporaryBinaryPath)
    renameSync(temporaryBinaryPath, binaryPath)
    writeFileSync(markerPath, `${expectedHash}\n`)
    return binaryPath
  } finally {
    if (existsSync(temporaryBinaryPath)) unlinkSync(temporaryBinaryPath)
  }
}
