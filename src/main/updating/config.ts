import { app } from 'electron'
import { readFileSync, realpathSync } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { MAC_UPDATE_FEED, PRODUCTION_APP_ID, UPDATE_REPOSITORY, type UpdateBuildConfig } from '../../shared/update-state'

let metadata: unknown
let loaded = false

function buildMetadata(): unknown {
  if (!loaded) {
    loaded = true
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { guziUpdate?: unknown }
    metadata = pkg.guziUpdate
  }
  return metadata
}

export function validateUpdateConfig(value: unknown): UpdateBuildConfig {
  if (!value || typeof value !== 'object') throw new Error('此安装包尚未配置应用内更新')
  const config = value as UpdateBuildConfig
  if (config.channel !== 'stable' && config.channel !== 'test') throw new Error('无效的更新渠道')
  if (config.repository !== UPDATE_REPOSITORY) throw new Error('更新仓库配置不匹配')
  if (typeof config.publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(config.publicKey) || Buffer.from(config.publicKey, 'base64').length !== 32) {
    throw new Error('安装包缺少有效的 Sparkle 公钥')
  }
  const feed = new URL(config.feedUrl)
  if (feed.username || feed.password || feed.hash) throw new Error('更新源地址无效')
  if (config.channel === 'stable') {
    if (config.appId !== PRODUCTION_APP_ID || config.feedUrl !== MAC_UPDATE_FEED || config.profileDir !== undefined) {
      throw new Error('正式更新配置不匹配')
    }
  } else {
    if (!/^cn\.shilong\.gooz\.update-test\.[a-zA-Z0-9.-]+$/.test(config.appId)) throw new Error('测试更新必须使用独立应用标识')
    if (feed.protocol !== 'https:' && !(feed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(feed.hostname))) {
      throw new Error('测试更新源必须为 HTTPS 或本机回环地址')
    }
    if (typeof config.profileDir !== 'string' || !isAbsolute(config.profileDir)) throw new Error('测试更新必须指定独立数据目录')
    const profile = resolve(config.profileDir)
    const roots = [tmpdir(), realpathSync(tmpdir()), '/private/tmp', '/tmp'].map((root) => resolve(root) + sep + 'guzi-update-')
    if (!roots.some((root) => profile.startsWith(root))) throw new Error('测试数据目录必须位于 guzi-update- 临时目录内')
  }
  return config
}

export function getUpdateBuildConfig(): UpdateBuildConfig | null {
  if (!app.isPackaged || process.platform !== 'darwin' || process.arch !== 'arm64') return null
  return validateUpdateConfig(buildMetadata())
}

export function getIsolatedUpdateProfile(): string | undefined {
  if (!app.isPackaged) return undefined
  const raw = buildMetadata() as Partial<UpdateBuildConfig> | undefined
  if (raw?.channel !== 'test') return undefined
  return validateUpdateConfig(raw).profileDir
}

export function isIsolatedUpdateTest(): boolean {
  return getIsolatedUpdateProfile() !== undefined
}
