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

export const UPDATE_REPOSITORY = 'Drangon-Li/guzi-assistant-releases'
export const MAC_UPDATE_FEED = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/appcast-mac-arm64.xml`
export const PRODUCTION_APP_ID = 'cn.shilong.gooz'
