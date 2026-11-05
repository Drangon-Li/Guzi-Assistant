export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'verifying' | 'ready' | 'preparing' | 'installing' | 'error'

export interface UpdateState {
  mode: 'sparkle' | 'legacy' | 'disabled'
  channel: 'development' | 'stable' | 'test'
  currentVersion: string
  phase: UpdatePhase
  version?: string
  notes?: string
  receivedBytes?: number
  totalBytes?: number
  progress?: number
  message?: string
  lastInstalledVersion?: string
}

export interface UpdateBuildConfig {
  channel: 'stable' | 'test'
  repository: string
  appId: string
  feedUrl: string
  publicKey: string
  profileDir?: string
}

// 源码仓库公开后，安装包与 Sparkle 更新源直接发布在源码仓库的 Releases 里。
// v0.13.0–v0.14.0 的安装包仍读旧仓库 guzi-assistant-releases，由迁移版本桥接一次。
export const UPDATE_REPOSITORY = 'Drangon-Li/Guzi-Assistant'
export const MAC_UPDATE_FEED = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/appcast-mac-arm64.xml`
export const PRODUCTION_APP_ID = 'cn.shilong.gooz'
