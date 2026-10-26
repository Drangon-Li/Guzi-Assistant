// Windows 保留现有更新入口；macOS 由 Sparkle 管理下载、校验和安装。
import { app, dialog, shell } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { firstNonBlank } from '@shared/env-value'
import { isNewerVersion, parseUpdateManifest, updateFeed } from '../shared/update-manifest.ts'
import { checkMacUpdates } from './updating/service'
import type { UpdateState } from '../shared/update-state'
export { bootstrapUpdater, cancelPendingUpdate, getUpdateState, downloadMacUpdate, installMacUpdate } from './updating/service'

const CHECK_INTERVAL_MS = 24 * 3600 * 1000

export interface UpdateCheckResult {
  status: 'update' | 'latest' | 'error'
  version?: string
  message?: string
}

function stampFile(): string {
  return join(app.getPath('userData'), 'update-check.json')
}

/** 检查更新。manual=true 时「已是最新/检查失败」也弹框反馈；启动静默检查只在有新版时打扰。 */
export async function checkForUpdates(manual: boolean): Promise<UpdateCheckResult | UpdateState> {
  if (process.platform === 'darwin') return checkMacUpdates()
  try {
    const configured = firstNonBlank(
      process.platform === 'win32' ? process.env.GUZI_ASSISTANT_WINDOWS_UPDATE_FEED : undefined,
      process.env.GUZI_ASSISTANT_UPDATE_FEED, process.env.ESHELL_UPDATE_FEED
    )
    const res = await fetch(updateFeed(process.platform, process.arch, configured), {
      headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000)
    })
    if (process.platform === 'win32' && res.status === 404) throw new Error('Windows 更新源尚未就绪，请稍后重试')
    if (!res.ok) throw new Error(`版本清单拉取失败（HTTP ${res.status}）`)
    const m = parseUpdateManifest(await res.json(), process.platform, process.arch)
    const remote = m.version
    try {
      writeFileSync(stampFile(), JSON.stringify({ last: Date.now() }))
    } catch {
      // 戳记写失败不致命，下次启动多查一次而已
    }
    if (!isNewerVersion(remote, app.getVersion())) {
      if (manual)
        void dialog.showMessageBox({
          type: 'info',
          message: '已是最新版本',
          detail: `当前版本 ${app.getVersion()}`
        })
      return { status: 'latest', version: app.getVersion() }
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `发现新版本 ${remote}`,
      detail: m.notes || `当前版本 ${app.getVersion()}，建议前往下载更新。`,
      buttons: ['前往下载', '稍后再说'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0 && typeof m.url === 'string' && /^https?:\/\//.test(m.url)) {
      void shell.openExternal(m.url)
    }
    return { status: 'update', version: remote }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (manual)
      void dialog.showMessageBox({ type: 'warning', message: '检查更新失败', detail: message })
    return { status: 'error', message }
  }
}

/** 启动后台检查：24 小时节流，静默进行（发现新版才弹框）。 */
export function scheduleStartupUpdateCheck(): void {
  if (process.platform === 'darwin') return
  const t = setTimeout(() => {
    try {
      const last = (JSON.parse(readFileSync(stampFile(), 'utf8')) as { last?: number }).last ?? 0
      if (Date.now() - last < CHECK_INTERVAL_MS) return
    } catch {
      // 无戳记/损坏 → 照常检查
    }
    void checkForUpdates(false)
  }, 8000)
  t.unref?.()
}
