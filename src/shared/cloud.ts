// 谷子云端 MCP 的渲染层可见类型（与 src/main/cloud/cloud-link.d.mts 保持一致）。

export type CloudConnection = 'signed_out' | 'disabled' | 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error'

export interface CloudUser {
  id: string
  username: string
  nickname: string
  email: string | null
}

export interface CloudState {
  signedIn: boolean
  user: CloudUser | null
  enabled: boolean
  connection: CloudConnection
  error: string
  deviceId: string
  endpoint: string
  accountUrl: string
}

export interface CloudToken {
  id: string
  name: string
  hint: string
  deviceId: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface CreatedCloudToken {
  token: string
  endpoint: string
  item: CloudToken
  configs: { claudeCode: string; json: string; codex: string; codexEnv: string; envName: string }
}
