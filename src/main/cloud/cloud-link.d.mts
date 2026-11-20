import type { EventEmitter } from 'node:events'

export type GuziApp = 'assistant' | 'scholar' | 'graph'
export type CloudConnection = 'signed_out' | 'disabled' | 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error'

export interface CloudUser {
  id: string
  username: string
  nickname: string
  email: string | null
  phone: string | null
  createdAt: number
}

export interface CloudState {
  app: GuziApp
  signedIn: boolean
  user: CloudUser | null
  enabled: boolean
  connection: CloudConnection
  error: string
  deviceId: string
  endpoint: string
  accountUrl: string
}

export interface CloudTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface CloudToolResult {
  content: unknown[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface CloudToken {
  id: string
  app: GuziApp
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

export interface CloudStorage {
  read(): Promise<Record<string, unknown> | null>
  write(state: Record<string, unknown>): Promise<void>
}

export interface CloudLinkOptions {
  app: GuziApp
  appVersion: string
  platform: string
  deviceName: () => string
  storage: CloudStorage
  tools: {
    list(): Promise<CloudTool[]>
    call(name: string, args: Record<string, unknown>, context: { signal: AbortSignal }): Promise<CloudToolResult>
  }
  accountOrigin?: string
  mcpOrigin?: string
  WebSocket?: typeof WebSocket
  fetch?: typeof fetch
  log?: (line: string) => void
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

export declare class CloudError extends Error {
  status: number
  code: string
}

export declare class CloudLink extends EventEmitter {
  constructor(options: CloudLinkOptions)
  initialize(): Promise<this>
  getState(): CloudState
  requestCode(input: { purpose: 'register' | 'login' | 'reset'; email: string }): Promise<{ cooldownSeconds: number }>
  register(input: { username: string; password: string; email: string; code: string }): Promise<CloudState>
  login(input: { identifier: string; password: string }): Promise<CloudState>
  loginWithCode(input: { email: string; code: string }): Promise<CloudState>
  logout(): Promise<CloudState>
  setEnabled(enabled: boolean): Promise<CloudState>
  refreshProfile(): Promise<CloudState>
  listTokens(): Promise<CloudToken[]>
  createToken(input: { name: string; bindDevice?: boolean }): Promise<CreatedCloudToken>
  revokeToken(id: string): Promise<{ ok: true }>
  toolsChanged(): Promise<void>
  nudge(): void
  dispose(): void
  on(event: 'state', listener: (state: CloudState) => void): this
}

export declare function createFileStorage(options: {
  file: string
  encrypt?: (text: string) => string
  decrypt?: (text: string) => string
  writeFile: (file: string, text: string) => Promise<void>
}): CloudStorage

export declare const PROTOCOL: 1
