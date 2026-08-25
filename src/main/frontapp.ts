import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import type { ActivityEventKind, ActivityPrivacyState } from '../shared/activity-events.ts'
import { ensureNativeHelperBinary } from './native-helper-cache.ts'
// v3 保留给手动/兼容调用（一次性读前台上下文）；v4 是 Hybrid History 的长驻 JSONL collector。
// Obj-C 源码在 native/*.m，经 ?raw 导入后由 native-helper-cache 按源码 hash 编译缓存。
import collectorObjcSrc from './native/frontmost-collector.m?raw'
import oneshotObjcSrc from './native/frontmost-oneshot.m?raw'

const execFileAsync = promisify(execFile)


export interface FrontmostContext {
  name: string
  bundleId: string
  windowTitle: string
  urlHost?: string
  windowId?: number
  focusedRole?: string
  focusedSubrole?: string
  safeLabel?: string
  targetRole?: string
  targetSubrole?: string
  targetId?: string
  command?: string
  modifiers?: string[]
  inputLength?: number | null
  secureInput?: boolean
  eventKind?: ActivityEventKind
  eventSource?: 'workspace' | 'accessibility' | 'collector'
}

export interface CollectorEvent {
  type:
    | 'app_activated'
    | 'heartbeat'
    | 'window_changed'
    | 'ax_focus_changed'
    | 'ax_attribute_changed'
    | 'selection_changed'
    | 'click'
    | 'right_click'
    | 'drag'
    | 'shortcut'
    | 'input_activity'
  appName: string
  bundleId: string
  windowTitle: string
  urlHost?: string
  windowId?: number
  focusedRole?: string
  focusedSubrole?: string
  safeLabel?: string
  targetRole?: string
  targetSubrole?: string
  targetId?: string
  command?: string
  modifiers?: string[]
  inputLength?: number | null
  secureInput?: boolean
  privacyState?: ActivityPrivacyState
  inputMonitoring?: 'available' | 'unavailable' | 'unknown'
  occurredAtMs: number
  accessibility: 'available' | 'unavailable'
}

export interface CollectorHealth {
  state: 'starting' | 'healthy' | 'degraded' | 'stopped'
  restartCount: number
  lastHeartbeatAtMs: number | null
  accessibility: 'available' | 'unavailable' | 'unknown'
  detail: string | null
  inputMonitoring?: 'available' | 'unavailable' | 'unknown'
}

export interface FrontmostCollectorHandle {
  stop(): void
}

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

let ensured: Promise<string> | null = null
let collectorEnsured: Promise<string> | null = null

async function ensureBinary(): Promise<string> {
  const bin = join(binDir(), 'frontmost-context-v3-oneshot')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'frontmost-context-v3-oneshot.m')
  writeFileSync(src, oneshotObjcSrc)
  await execFileAsync('/usr/bin/xcrun', [
    'clang',
    '-fobjc-arc',
    '-O2',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-framework',
    'CoreGraphics',
    '-o',
    bin,
    src
  ])
  return bin
}

async function ensureCollectorBinary(): Promise<string> {
  return ensureNativeHelperBinary({
    directory: binDir(),
    binaryName: 'frontmost-context-v4-ax',
    source: collectorObjcSrc,
    compile: async (src, bin) => {
      await execFileAsync('/usr/bin/xcrun', [
        'clang',
        '-fobjc-arc',
        '-O2',
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
        '-framework',
        'CoreGraphics',
        '-o',
        bin,
        src
      ])
    }
  })
}

function normalizeCollectorHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const host = value.normalize('NFKC').trim().toLowerCase()
  if (!host || host.length > 255 || /[\s/?#:@]/.test(host)) return undefined
  return host
}

function parseCollectorLine(line: string): CollectorEvent | null {
  try {
    const raw = JSON.parse(line) as Partial<CollectorEvent>
    const rawRecord = raw as Record<string, unknown>
    if (
      'text' in rawRecord ||
      'characters' in rawRecord ||
      'charactersIgnoringModifiers' in rawRecord ||
      'selectedText' in rawRecord ||
      'selected_text' in rawRecord ||
      'key' in rawRecord ||
      'keyCode' in rawRecord ||
      'value' in rawRecord ||
      'axValue' in rawRecord ||
      'url' in rawRecord ||
      'fullUrl' in rawRecord ||
      'documentURL' in rawRecord ||
      'URLString' in rawRecord ||
      'browserURL' in rawRecord
    )
      return null
    if (
      (raw.type !== 'app_activated' &&
        raw.type !== 'heartbeat' &&
        raw.type !== 'window_changed' &&
        raw.type !== 'ax_focus_changed' &&
        raw.type !== 'ax_attribute_changed' &&
        raw.type !== 'selection_changed' &&
        raw.type !== 'click' &&
        raw.type !== 'right_click' &&
        raw.type !== 'drag' &&
        raw.type !== 'shortcut' &&
        raw.type !== 'input_activity') ||
      typeof raw.appName !== 'string' ||
      typeof raw.bundleId !== 'string' ||
      typeof raw.windowTitle !== 'string' ||
      typeof raw.occurredAtMs !== 'number' ||
      !Number.isFinite(raw.occurredAtMs) ||
      (raw.accessibility !== 'available' && raw.accessibility !== 'unavailable')
    ) return null
    return {
      type: raw.type,
      appName: raw.appName.slice(0, 80),
      bundleId: raw.bundleId.slice(0, 160),
      windowTitle: raw.windowTitle.slice(0, 160),
      urlHost: normalizeCollectorHost(raw.urlHost),
      windowId:
        typeof raw.windowId === 'number' && Number.isFinite(raw.windowId)
          ? Math.max(0, Math.trunc(raw.windowId))
          : undefined,
      focusedRole: typeof raw.focusedRole === 'string' ? raw.focusedRole.slice(0, 80) : undefined,
      focusedSubrole: typeof raw.focusedSubrole === 'string' ? raw.focusedSubrole.slice(0, 80) : undefined,
      safeLabel: typeof raw.safeLabel === 'string' ? raw.safeLabel.slice(0, 160) : undefined,
      targetRole: typeof raw.targetRole === 'string' ? raw.targetRole.slice(0, 80) : undefined,
      targetSubrole: typeof raw.targetSubrole === 'string' ? raw.targetSubrole.slice(0, 80) : undefined,
      targetId: typeof raw.targetId === 'string' ? raw.targetId.slice(0, 160) : undefined,
      command: typeof raw.command === 'string' ? raw.command.slice(0, 80) : undefined,
      modifiers: Array.isArray(raw.modifiers)
        ? raw.modifiers.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 24)).slice(0, 8)
        : undefined,
      inputLength:
        typeof raw.inputLength === 'number' && Number.isFinite(raw.inputLength)
          ? Math.max(0, Math.min(100_000, Math.trunc(raw.inputLength)))
          : undefined,
      secureInput: raw.secureInput === true,
      privacyState:
        raw.privacyState === 'private' ||
        raw.privacyState === 'excluded' ||
        raw.privacyState === 'own' ||
        raw.privacyState === 'secure'
          ? raw.privacyState
          : undefined,
      inputMonitoring:
        raw.inputMonitoring === 'available' || raw.inputMonitoring === 'unavailable' || raw.inputMonitoring === 'unknown'
          ? raw.inputMonitoring
          : undefined,
      occurredAtMs: raw.occurredAtMs,
      accessibility: raw.accessibility
    }
  } catch {
    return null
  }
}

/** Long-lived JSONL collector with bounded restart attempts and heartbeat watchdog. */
export function startFrontmostCollector(
  onEvent: (event: CollectorEvent) => void,
  onHealth: (health: CollectorHealth) => void
): FrontmostCollectorHandle {
  let child: ChildProcessWithoutNullStreams | null = null
  let stopped = false
  let restartCount = 0
  let lastHeartbeatAtMs: number | null = null
  let launchStartedAtMs = Date.now()
  let accessibility: CollectorHealth['accessibility'] = 'unknown'
  let inputMonitoring: NonNullable<CollectorHealth['inputMonitoring']> = 'unknown'
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let buffer = ''

  const report = (state: CollectorHealth['state'], detail: string | null = null): void => {
    onHealth({ state, restartCount, lastHeartbeatAtMs, accessibility, detail, inputMonitoring })
  }

  const scheduleRestart = (detail: string): void => {
    if (stopped) return
    if (restartTimer) return
    child = null
    if (restartCount >= 3) {
      report('degraded', detail)
      return
    }
    const delay = 500 * 2 ** restartCount
    restartCount += 1
    report('degraded', detail)
    restartTimer = setTimeout(() => {
      restartTimer = null
      void launch()
    }, delay)
  }

  const launch = async (): Promise<void> => {
    if (stopped || child) return
    report('starting')
    try {
      if (collectorEnsured && !existsSync(await collectorEnsured.catch(() => ''))) collectorEnsured = null
      if (!collectorEnsured) collectorEnsured = ensureCollectorBinary()
      const bin = await collectorEnsured
      if (stopped) return
      const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      child = proc
      launchStartedAtMs = Date.now()
      lastHeartbeatAtMs = null
      inputMonitoring = 'unknown'
      buffer = ''
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = parseCollectorLine(line.trim())
          if (!event) continue
          if (event.type === 'heartbeat') lastHeartbeatAtMs = event.occurredAtMs
          accessibility = event.accessibility
          if (event.inputMonitoring) inputMonitoring = event.inputMonitoring
          report(event.accessibility === 'available' ? 'healthy' : 'degraded', event.accessibility === 'available' ? null : 'Accessibility unavailable')
          onEvent(event)
        }
      })
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        const detail = chunk.trim().slice(0, 160)
        if (detail) report('degraded', detail)
      })
      proc.once('error', (error) => scheduleRestart(error.message))
      proc.once('exit', (code, signal) => {
        if (!stopped) scheduleRestart(`collector exited (${code ?? 'null'}/${signal ?? 'none'})`)
      })
    } catch (error) {
      scheduleRestart(error instanceof Error ? error.message : String(error))
    }
  }

  watchdogTimer = setInterval(() => {
    if (stopped || !child) return
    const now = Date.now()
    const heartbeatReference = lastHeartbeatAtMs ?? launchStartedAtMs
    if (now - heartbeatReference > 7_000) {
      child.kill()
      scheduleRestart('heartbeat timeout')
    }
  }, 3_000)
  void launch()

  return {
    stop(): void {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      if (child) child.kill()
      child = null
      report('stopped')
    }
  }
}

/** Current foreground app context; manual and legacy paths keep this fail-closed helper. */
export async function getFrontmostContext(): Promise<FrontmostContext | null> {
  try {
    if (ensured && !existsSync(await ensured.catch(() => ''))) ensured = null
    if (!ensured)
      ensured = ensureBinary().catch((e) => {
        ensured = null
        throw e
      })
    const bin = await ensured
    const { stdout } = await execFileAsync(bin, [], { timeout: 3000 })
    const raw = stdout.trim()
    if (!raw) return null
    const context = JSON.parse(raw) as Partial<FrontmostContext>
    if (
      typeof context.name !== 'string' ||
      typeof context.bundleId !== 'string' ||
      typeof context.windowTitle !== 'string'
    ) return null
    return { name: context.name, bundleId: context.bundleId, windowTitle: context.windowTitle }
  } catch {
    return null
  }
}

/** 当前前台 App 的本地化名称；兼容现有排除和切换检测调用方。 */
export async function getFrontmostApp(): Promise<string | null> {
  const context = await getFrontmostContext()
  return context?.name || null
}
