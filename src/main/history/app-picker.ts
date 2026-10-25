import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { dialog } from 'electron'
import type { HistoryAppSelection } from '@shared/types'

const execFileAsync = promisify(execFile)

async function plistValue(infoPath: string, key: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/plutil',
      ['-extract', key, 'raw', '-o', '-', infoPath],
      { timeout: 1500, maxBuffer: 64 * 1024 }
    )
    return stdout.trim()
  } catch {
    return ''
  }
}

async function readApplication(path: string): Promise<HistoryAppSelection | null> {
  if (process.platform === 'win32') {
    if (!path.toLowerCase().endsWith('.exe') || !existsSync(path)) return null
    try {
      const { execWindowsHelper } = await import('../platform/windows-helper.ts')
      const raw = JSON.parse(await execWindowsHelper(['app-info', path])) as Partial<HistoryAppSelection>
      if (typeof raw.bundleId !== 'string' || !/^win32:[^:]+\.exe:[0-9a-f]{16}$/.test(raw.bundleId) ||
          typeof raw.name !== 'string' || !raw.name || typeof raw.path !== 'string') return null
      return { bundleId: raw.bundleId, name: raw.name, path: raw.path }
    } catch {
      return null
    }
  }
  if (!path.toLowerCase().endsWith('.app')) return null
  const infoPath = join(path, 'Contents', 'Info.plist')
  if (!existsSync(infoPath)) return null
  const bundleId = await plistValue(infoPath, 'CFBundleIdentifier')
  if (!bundleId) return null
  const name =
    (await plistValue(infoPath, 'CFBundleDisplayName')) ||
    (await plistValue(infoPath, 'CFBundleName')) ||
    basename(path, '.app')
  return { bundleId, name, path }
}

/** Return the same application identity used by the platform collector. */
export async function pickHistoryApps(): Promise<HistoryAppSelection[] | null> {
  const result = await dialog.showOpenDialog({
    title: '选择要排除的 App',
    message: '选中的 App 不会写入历史记录',
    defaultPath: process.platform === 'darwin' && existsSync('/Applications') ? '/Applications' : undefined,
    buttonLabel: '加入黑名单',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '应用程序', extensions: process.platform === 'win32' ? ['exe'] : ['app'] }]
  })
  if (result.canceled) return null

  const selected = await Promise.all(result.filePaths.map((path) => readApplication(path)))
  const unique = new Map<string, HistoryAppSelection>()
  for (const app of selected) {
    if (app) unique.set(app.bundleId.toLowerCase(), app)
  }
  return [...unique.values()]
}
