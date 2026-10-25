export interface UpdateManifest {
  version: string
  notes?: string
  url: string
  platform?: string
  arch?: string
  installerType?: string
}

const RELEASES = 'https://rtgypddrknuylecqejmp.supabase.co/storage/v1/object/public/releases'

export function updateFeed(platform: string, arch: string, configured?: string): string {
  if (platform !== 'darwin' && !(platform === 'win32' && arch === 'x64')) {
    throw new Error('当前平台暂未提供更新源')
  }
  return configured || `${RELEASES}/${platform === 'darwin' ? 'latest-mac.json' : 'latest-win-x64.json'}`
}

export function parseUpdateManifest(value: unknown, platform: string, arch: string): UpdateManifest {
  if (!value || typeof value !== 'object') throw new Error('版本清单格式无效')
  const m = value as Partial<UpdateManifest>
  const version = typeof m.version === 'string' ? m.version.replace(/^v/, '') : ''
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本清单缺少有效的 version 字段')
  if (typeof m.url !== 'string' || !/^https?:\/\//.test(m.url)) throw new Error('版本清单缺少有效的下载地址')
  if (platform === 'win32') {
    if (m.platform !== 'win32' || m.arch !== arch || m.installerType !== 'nsis') {
      throw new Error('更新清单与 Windows x64 安装版不匹配')
    }
    const url = new URL(m.url)
    if (url.protocol !== 'https:' || url.username || url.password || !url.pathname.toLowerCase().endsWith('.exe')) {
      throw new Error('Windows 更新地址必须指向 HTTPS 安装程序')
    }
  }
  return { ...m, version, url: m.url } as UpdateManifest
}

export function isNewerVersion(remote: string, local: string): boolean {
  const ra = remote.split('.').map(Number)
  const la = local.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((ra[i] || 0) !== (la[i] || 0)) return (ra[i] || 0) > (la[i] || 0)
  }
  return false
}
