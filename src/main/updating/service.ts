import { app } from 'electron'
import { createRequire } from 'module'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ExitReason, ExitResult } from '../../shared/exit-lifecycle'
import type { UpdateState } from '../../shared/update-state'
import { broadcast } from '../windows'
import { getUpdateBuildConfig } from './config'

interface NativeSnapshot {
  phase: string
  version?: string
  displayVersion?: string
  notes?: string
  receivedBytes?: number
  totalBytes?: number
  progress?: number
  error?: string
  message?: string
  code?: number
  sessionInProgress: boolean
  ready: boolean
}
interface SparkleBridge {
  start(): boolean
  check(): boolean
  download(): boolean
  install(): boolean
  cancel(): void
  status(): string
}
type ExitRequester = (reason: ExitReason, commit: () => void | Promise<void>) => Promise<ExitResult>
let bridge: SparkleBridge | null = null
let requestExit: ExitRequester | null = null
let poll: ReturnType<typeof setInterval> | null = null
let cancelling: Promise<void> | null = null
let installing: Promise<UpdateState> | null = null
let operation: Promise<UpdateState> | null = null
let state: UpdateState = {
  mode: process.platform === 'win32' ? 'legacy' : 'disabled', channel: 'development',
  currentVersion: app.getVersion(), phase: 'disabled', message: '开发环境不启用应用内更新'
}

function publish(patch: Partial<UpdateState>): UpdateState {
  const next = { ...state, ...patch }
  if (JSON.stringify(next) !== JSON.stringify(state)) {
    state = next
    broadcast('guzi-assistant:update-state', state)
  }
  return { ...state }
}

function snapshot(): NativeSnapshot {
  if (!bridge) throw new Error(state.message || '更新组件尚未就绪')
  return JSON.parse(bridge.status()) as NativeSnapshot
}

function refresh(): NativeSnapshot {
  const native = snapshot()
  const version = native.displayVersion || native.version
  if (state.channel === 'stable' && version && (!/^\d+\.\d+\.\d+$/.test(version) || native.version !== version)) {
    bridge?.cancel()
    const error = '正式更新源包含无效版本，已拒绝安装'
    publish({ phase: 'error', message: error })
    return { ...native, phase: 'error', ready: false, error }
  }
  if (!cancelling && !installing) {
    const phase = native.phase === 'cancelled' ? (version ? 'available' : 'idle') : native.phase
    const known = ['idle', 'checking', 'latest', 'available', 'downloading', 'verifying', 'ready', 'installing', 'error']
    if (known.includes(phase)) publish({
      phase: phase as UpdateState['phase'], version: version || state.version,
      notes: native.notes || state.notes,
      receivedBytes: native.receivedBytes, totalBytes: native.totalBytes, progress: native.progress,
      message: phase === 'error' ? native.error || native.message || '更新失败，请重试' : undefined
    })
  }
  if (!native.sessionInProgress || ['available', 'ready', 'error', 'latest'].includes(native.phase)) stopPolling()
  return native
}

function startPolling(): void {
  if (poll) return
  poll = setInterval(() => {
    try { refresh() } catch (error) { fail(error); stopPolling() }
  }, 150)
  poll.unref()
}
function stopPolling(): void { if (poll) clearInterval(poll); poll = null }
function fail(error: unknown): UpdateState {
  return publish({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
}

async function until(predicate: (value: NativeSnapshot) => boolean, timeout: number, allowError = false): Promise<NativeSnapshot> {
  const deadline = Date.now() + timeout
  while (true) {
    const value = refresh()
    if (predicate(value)) return value
    if (!allowError && value.phase === 'error') throw new Error(value.error || value.message || '更新失败')
    if (Date.now() >= deadline) throw new Error('更新组件没有完成当前操作；应用保持打开，请稍后重试')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function intentPath(): string { return join(app.getPath('userData'), 'update-install.json') }
function writeIntent(value: { targetVersion: string; requestedAt: string; completed?: boolean }): void {
  const destination = intentPath()
  writeFileSync(destination + '.tmp', JSON.stringify(value), { mode: 0o600 })
  renameSync(destination + '.tmp', destination)
}

export function bootstrapUpdater(exit: ExitRequester): void {
  requestExit = exit
  if (process.platform !== 'darwin') {
    publish({ mode: process.platform === 'win32' ? 'legacy' : 'disabled', phase: 'disabled', message: '当前平台保留原有更新方式' })
    return
  }
  try {
    const config = getUpdateBuildConfig()
    if (!config) return
    const requireNative = createRequire(join(app.getAppPath(), 'package.json'))
    bridge = requireNative(join(process.resourcesPath, 'native', 'sparkle-bridge.node')) as SparkleBridge
    if (!bridge.start()) throw new Error(snapshot().error || snapshot().message || 'Sparkle 初始化失败')
    publish({ mode: 'sparkle', channel: config.channel, phase: 'idle', message: undefined })
    try {
      const intent = JSON.parse(readFileSync(intentPath(), 'utf8')) as { targetVersion: string; requestedAt: string; completed?: boolean }
      if (intent.targetVersion === app.getVersion()) {
        writeIntent({ ...intent, completed: true })
        publish({ lastInstalledVersion: intent.targetVersion })
      } else if (!intent.completed) {
        publish({ message: `上次更新至 ${intent.targetVersion} 尚未完成，可重新检查并重试。` })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') publish({ message: '无法读取上次安装状态，请重新检查更新。' })
    }
  } catch (error) {
    bridge = null
    publish({ mode: 'disabled', phase: 'disabled', message: error instanceof Error ? error.message : String(error) })
  }
}

export function getUpdateState(): UpdateState { return { ...state } }

export function checkMacUpdates(): Promise<UpdateState> {
  if (operation) return operation
  operation = (async () => {
    try {
      if (!bridge) return getUpdateState()
      if (installing || cancelling) return getUpdateState()
      const current = refresh()
      if (current.sessionInProgress) return getUpdateState()
      if (!bridge.check()) throw new Error('更新检查暂不可用，请稍后重试')
      publish({ phase: 'checking', message: undefined })
      startPolling()
      await until((value) => value.phase === 'available' || value.phase === 'latest' || !value.sessionInProgress, 60_000)
      return getUpdateState()
    } catch (error) { return fail(error) }
  })().finally(() => { operation = null })
  return operation
}

export async function downloadMacUpdate(): Promise<UpdateState> {
  if (installing || cancelling) return getUpdateState()
  if (!bridge) return getUpdateState()
  try {
    let current = refresh()
    if (current.phase === 'error') return getUpdateState()
    if (current.phase === 'ready' || current.phase === 'downloading' || current.phase === 'verifying') return getUpdateState()
    if (current.phase !== 'available' || !current.sessionInProgress) {
      await checkMacUpdates()
      current = refresh()
    }
    if (current.phase !== 'available') return getUpdateState()
    if (!bridge.download()) throw new Error('更新下载未能启动，请重新检查更新')
    publish({ phase: 'downloading', message: undefined, receivedBytes: 0, progress: 0 })
    startPolling()
    return getUpdateState()
  } catch (error) { return fail(error) }
}

export function cancelPendingUpdate(): Promise<void> {
  if (cancelling) return cancelling
  if (!bridge) return Promise.resolve()
  cancelling = (async () => {
    bridge!.cancel()
    await until((value) => !value.sessionInProgress, 60_000, true)
    stopPolling()
    publish({ phase: state.version ? 'available' : 'idle', progress: undefined, receivedBytes: undefined, totalBytes: undefined })
  })().catch((error) => { fail(error); throw error }).finally(() => { cancelling = null })
  return cancelling
}

export function installMacUpdate(): Promise<UpdateState> {
  if (installing) return installing
  installing = (async () => {
    try {
      if (!bridge || !requestExit) throw new Error('更新组件尚未就绪')
      const current = refresh()
      if (!current.ready || current.phase !== 'ready') throw new Error('更新包尚未下载并验证完成')
      const targetVersion = current.displayVersion || current.version
      if (!targetVersion) throw new Error('更新包缺少版本信息')
      publish({ phase: 'preparing', message: undefined })
      const result = await requestExit('install-update', async () => {
        if (!snapshot().ready) throw new Error('待安装更新已取消，请重新下载')
        writeIntent({ targetVersion, requestedAt: new Date().toISOString() })
        publish({ phase: 'installing', message: undefined })
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setInterval>
          let timeout: ReturnType<typeof setTimeout>
          let finished = false
          const finish = (error?: Error): void => {
            if (finished) return
            finished = true
            clearInterval(timer); clearTimeout(timeout)
            app.removeListener('before-quit', quitting)
            if (error) reject(error); else resolve()
          }
          const quitting = (): void => finish()
          app.once('before-quit', quitting)
          timer = setInterval(() => {
            try {
              const native = snapshot()
              if (native.phase === 'error' || native.phase === 'cancelled') finish(new Error(native.error || native.message || '安装未能启动'))
            } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
          }, 100)
          timeout = setTimeout(() => finish(new Error('安装器未能请求重启，已保留应用，请重试')), 30_000)
          try {
            if (!bridge!.install()) finish(new Error('Sparkle 拒绝启动安装'))
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
        })
      })
      if (result.status === 'failed') return fail(result.message)
      if (result.status === 'cancelled') publish({ phase: 'available', message: '已取消安装，当前内容保留。再次安装前会重新验证更新包。' })
      return getUpdateState()
    } catch (error) {
      try { await cancelPendingUpdate() } catch { /* The cancellation error is already visible in state. */ }
      return fail(error)
    }
  })().finally(() => { installing = null })
  return installing
}
