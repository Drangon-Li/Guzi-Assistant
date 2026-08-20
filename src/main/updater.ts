// 更新检查 —— 未签名阶段的轻量方案：拉版本清单 → 比对版本 → 系统对话框引导下载 dmg。
// macOS 上 electron-updater 的自动安装依赖代码签名，拿到开发者证书后可平滑升级；
// 清单放 Supabase Storage 公共桶（仓库是 private，GitHub Releases 匿名拉不到）。
// 发布流程见 scripts/publish-release.sh：构建 → 上传 dmg + latest-mac.json。
import { app, dialog, shell } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { firstNonBlank } from '@shared/env-value'

const FEED_URL =
  firstNonBlank(process.env.GUZI_ASSISTANT_UPDATE_FEED, process.env.ESHELL_UPDATE_FEED) ||
  'https://rtgypddrknuylecqejmp.supabase.co/storage/v1/object/public/releases/latest-mac.json'
const CHECK_INTERVAL_MS = 24 * 3600 * 1000

interface Manifest {
  version?: string
  notes?: string
  url?: string
}

export interface UpdateCheckResult {
  status: 'update' | 'latest' | 'error'
  version?: string
  message?: string
}

function newer(remote: string, local: string): boolean {
  const ra = remote.split('.').map(Number)
  const la = local.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const a = ra[i] || 0
    const b = la[i] || 0
    if (a !== b) return a > b
  }
  return false
}

function stampFile(): string {
  return join(app.getPath('userData'), 'update-check.json')
}

/** 检查更新。manual=true 时「已是最新/检查失败」也弹框反馈；启动静默检查只在有新版时打扰。 */
export async function checkForUpdates(manual: boolean): Promise<UpdateCheckResult> {
  try {
    const res = await fetch(FEED_URL, { headers: { 'cache-control': 'no-cache' } })
    if (!res.ok) throw new Error(`版本清单拉取失败（HTTP ${res.status}）`)
    const m = (await res.json()) as Manifest
    const remote = typeof m.version === 'string' ? m.version.replace(/^v/, '') : ''
    if (!remote) throw new Error('版本清单缺少 version 字段')
    try {
      writeFileSync(stampFile(), JSON.stringify({ last: Date.now() }))
    } catch {
      // 戳记写失败不致命，下次启动多查一次而已
    }
    if (!newer(remote, app.getVersion())) {
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
