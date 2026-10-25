import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { PassThrough } from 'node:stream'
import {
  getScreenActivityStatus,
  startActivityCollector,
  stopActivityCollector
} from '../src/main/activity-tracker.ts'

const processes = []
const health = []
const fixture = {
  spawn() {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.stdin = new PassThrough()
    proc.kill = () => { proc.killed = true }
    processes.push(proc)
    return proc
  }
}
globalThis.__inputHealthFixture = fixture
const mocks = {
  electron: 'export const app={getPath:()=>"/fixture"};',
  child_process: 'export const spawn=(...args)=>globalThis.__inputHealthFixture.spawn(...args),execFile=()=>{throw Error("unexpected native execution")};',
  './native-helper-cache.ts': 'export const ensureNativeHelperBinary=async()=>"/fixture/collector";'
}
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/src/main/frontapp.ts')) {
      if (mocks[specifier]) return { url: `input-fixture:${encodeURIComponent(specifier)}`, shortCircuit: true }
      if (specifier.endsWith('.m?raw')) return { url: 'input-fixture:native', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('/src/main/frontapp.ts')) {
      const loaded = next(url, context)
      return { ...loaded, source: readFileSync(new URL(url), 'utf8').replaceAll('process.platform', "'darwin'") }
    }
    if (url.startsWith('input-fixture:')) return {
      format: 'module', shortCircuit: true,
      source: mocks[decodeURIComponent(url.slice('input-fixture:'.length))] ?? 'export default "fixture";'
    }
    return next(url, context)
  }
})
const realSetTimeout = globalThis.setTimeout
const realSetInterval = globalThis.setInterval
const realClearTimeout = globalThis.clearTimeout
const realClearInterval = globalThis.clearInterval
let restart
globalThis.setTimeout = (callback) => { restart = callback; return 123 }
globalThis.setInterval = () => 456
globalThis.clearTimeout = () => { restart = undefined }
globalThis.clearInterval = () => {}
const flush = () => new Promise(setImmediate)
const status = () => getScreenActivityStatus({ eventDriven: true, hybridV2: true, running: true, paused: false })
const at = Date.now() - 1_000
const base = { type: 'heartbeat', appName: '', bundleId: '', windowTitle: '', accessibility: 'available', occurredAtMs: at }
const emit = (patch = {}, proc = processes.at(-1)) => proc.stdout.write(`${JSON.stringify({ ...base, ...patch })}\n`)

try {
  const { startFrontmostCollector } = await import('../src/main/frontapp.ts')
  startActivityCollector(() => ({ suppressed: false, privacyState: 'normal' }), async () => ({
    startFrontmostCollector: (onEvent, onHealth) => startFrontmostCollector(onEvent, (value) => {
      health.push(value)
      onHealth(value)
    })
  }))
  await flush()
  assert.equal(processes.length, 1, 'only the mocked collector may start')
  emit({ inputMonitoring: 'unknown', inputMonitoringPermission: 'available', inputMonitoringListener: 'active', lastInputEventAtMs: null })
  assert.equal(status().inputMonitoringPermission, 'available')
  assert.equal(status().inputMonitoringListener, 'active')
  assert.equal(status().inputMonitoring, 'unknown', 'permission and an installed listener must not claim observed events')
  assert.equal(status().lastInputEventAt, null)
  assert.equal(status().collector, 'healthy')
  console.log('✓ 已授权、监听已建立、等待首事件保持独立且不伪造验证')

  emit({ type: 'click', inputMonitoring: 'available', inputMonitoringPermission: 'available', inputMonitoringListener: 'active', lastInputEventAtMs: at })
  assert.equal(status().inputMonitoring, 'available')
  assert.equal(status().lastInputEventAt, new Date(at).toISOString())
  emit({ occurredAtMs: at + 100 })
  assert.equal(status().lastInputEventAt, new Date(at).toISOString(), 'heartbeat time must not replace the actual event time')
  emit({ lastInputEventAtMs: 1e100, inputMonitoringListener: 'invalid', inputMonitoringPermission: 'invalid' })
  assert.equal(status().lastInputEventAt, new Date(at).toISOString())
  assert.equal(status().inputMonitoringListener, 'active')
  assert.equal(status().inputMonitoringPermission, 'available')
  console.log('✓ 实际事件更新时间；稀疏heartbeat和无效字段不覆盖它')

  emit({ inputMonitoring: 'unavailable', inputMonitoringPermission: 'unavailable', inputMonitoringListener: 'active' })
  assert.equal(status().collector, 'degraded', 'heartbeat must not overwrite permission failure with healthy')
  assert.match(status().collectorDetail, /permission unavailable/)
  emit({ inputMonitoringPermission: 'available', inputMonitoringListener: 'inactive' })
  assert.equal(status().collector, 'degraded')
  assert.match(status().collectorDetail, /listener unavailable/)
  emit({ accessibility: 'unavailable', inputMonitoring: 'available', inputMonitoringPermission: 'available', inputMonitoringListener: 'active' })
  assert.equal(status().collector, 'degraded')
  assert.equal(status().inputMonitoring, 'available')
  assert.match(status().collectorDetail, /Accessibility unavailable/)
  console.log('✓ 授权失败、监听失败、AX失败都保持降级且分别可诊断')

  const old = processes[0]
  old.emit('exit', 1, null)
  assert.equal(status().inputMonitoringListener, 'inactive')
  assert.equal(status().inputMonitoring, 'unknown')
  restart()
  await flush()
  assert.equal(processes.length, 2)
  assert.equal(status().inputMonitoringPermission, 'unknown')
  assert.equal(status().inputMonitoringListener, 'unknown')
  assert.equal(status().lastInputEventAt, null)
  const beforeLateEvent = health.length
  emit({ inputMonitoring: 'available', lastInputEventAtMs: at }, old)
  assert.equal(health.length, beforeLateEvent, 'old process output must not restore stale health after restart')
  emit({ inputMonitoring: 'available' })
  assert.equal(status().inputMonitoring, 'available', 'old collector JSONL remains supported')
  assert.equal(status().inputMonitoringPermission, 'unknown', 'legacy events cannot invent a separate permission result')
  assert.equal(status().lastInputEventAt, null)
  stopActivityCollector()
  assert.equal(status().collector, 'stopped')
  assert.equal(status().inputMonitoringListener, 'inactive')
  assert.equal(status().inputMonitoring, 'unknown')
  assert.ok(processes.every(proc => proc.killed || proc === old))
  console.log('✓ 重启复位探针、忽略旧进程输出、兼容旧JSONL；停止后监听失效')
} finally {
  stopActivityCollector()
  hook.deregister()
  globalThis.setTimeout = realSetTimeout
  globalThis.setInterval = realSetInterval
  globalThis.clearTimeout = realClearTimeout
  globalThis.clearInterval = realClearInterval
  delete globalThis.__inputHealthFixture
}
