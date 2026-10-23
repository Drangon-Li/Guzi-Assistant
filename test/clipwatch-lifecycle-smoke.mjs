import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../src/main/clipwatch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const init = deferred()
  const settings = { clipWatchEnabled: true, screenSenseExcludedApps: [], screenSensePopup: true }
  const state = { processes: [], requests: [], writes: 0, shows: 0, paused: false, timers: new Map() }
  class CooldownMap { sweep() {} untilMs() {} start() {} clear() {} }
  const mocks = {
    child_process: {
      execFile: (_bin, _args, callback) => callback(null, ''),
      spawn: () => {
        const proc = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.stdout.setEncoding = proc.stderr.setEncoding = () => {}
        proc.kill = () => { proc.killed = true }
        state.processes.push(proc)
        return proc
      }
    },
    './native/clipboard-detect.m?raw': { default: '__POLL_MS__ __PIPE_MAX_CHARS__' },
    electron: { app: { getPath: () => '/mock-user-data' } },
    fs: { existsSync: () => true },
    path: require('node:path'),
    util: require('node:util'),
    '@shared/phash': { textHash: (text) => text },
    '@shared/sensitive': { redactSensitive: (text) => ({ text, hits: [] }) },
    '@shared/clip-gate': {
      CLIP_LIMITS: { cooldownMs: 1 },
      decideClipboardFastPath: () => ({ fast: false }),
      decideClipboardParse: () => ({ run: true })
    },
    '@shared/cooldown': { CooldownMap },
    './capture': { HINTS: { clipboard_text: 'clipboard hint' } },
    './db': { getSettings: () => settings },
    './native-helper-cache': { ensureNativeHelperBinary: () => init.promise },
    './parser': {
      cloudReady: () => true,
      parseToItems: (input) => {
        const request = { ...deferred(), input }
        state.requests.push(request)
        return request.promise
      }
    },
    './pet/controller': { applyExternalPetSay() {} },
    './detection-cards': {
      buildDetectionCards: () => { state.writes++; return [{}] },
      buildLocalItem() {},
      parsedToExtraction: (item) => item,
      showDetectedCards: () => { state.shows++ }
    },
    './screenwatch': { isWatchPaused: () => state.paused },
    './windows': { debugEvent() {}, debugIsOpen: () => false }
  }
  const context = {
    exports: {}, process: { platform: 'darwin' }, AbortController,
    require: (name) => { assert.ok(name in mocks, `Unexpected dependency: ${name}`); return mocks[name] },
    setTimeout: (callback) => { const timer = { unref() {} }; state.timers.set(timer, callback); return timer },
    clearTimeout: (timer) => state.timers.delete(timer)
  }
  vm.runInNewContext(source, context, { filename: 'clipwatch.ts' })
  return { api: context.exports, init, settings, state }
}

const settle = () => new Promise(setImmediate)
const hit = (proc) => proc.stdout.emit('data', JSON.stringify({
  type: 'hit', text: '明天下午交报告', app: 'Messages', bundleId: 'com.apple.MobileSMS'
}) + '\n')
const items = [{ belongs_to_user: 'yes', title: '交报告' }]
async function start(f) {
  f.api.startClipWatch()
  f.init.resolve('/mock-helper')
  await settle()
  return f.state.processes.at(-1)
}

let failed = 0
async function test(name, run) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { failed++; console.error(`✗ ${name}\n${error.stack}`) }
}

await test('关闭捕获中止请求，并拒绝忽略取消信号的迟到结果', async () => {
  const f = fixture()
  const proc = await start(f)
  hit(proc)
  const request = f.state.requests[0]
  f.settings.clipWatchEnabled = false
  f.api.stopClipWatch()
  request.resolve(items)
  await settle()
  assert.equal(f.state.writes, 0)
  assert.equal(f.state.shows, 0)
  assert.equal(request.input.signal?.aborted, true)
})

await test('重新启用可立即处理新内容，旧请求收尾不能释放新请求的互斥状态', async () => {
  const f = fixture()
  hit(await start(f))
  const old = f.state.requests[0]
  f.api.stopClipWatch()
  const current = await start(f)
  hit(current)
  assert.equal(f.state.requests.length, 2)
  old.resolve(items)
  await settle()
  assert.equal(f.state.writes, 0)
  hit(current)
  assert.equal(f.state.requests.length, 2)
  f.state.requests[1].resolve(items)
  await settle()
  assert.equal(f.state.writes, 1)
  assert.equal(f.state.shows, 1)
  f.api.stopClipWatch()
})

await test('托盘暂停时不处理已在途模型返回的候选', async () => {
  const f = fixture()
  hit(await start(f))
  f.state.paused = true
  f.state.requests[0].resolve(items)
  await settle()
  assert.equal(f.state.writes, 0)
  assert.equal(f.state.shows, 0)
  f.api.stopClipWatch()
})

await test('初始化期间 start-stop-start 仅启动一个 helper，停止后没有残留', async () => {
  const f = fixture()
  f.api.startClipWatch()
  f.api.stopClipWatch()
  f.api.startClipWatch()
  f.init.resolve('/mock-helper')
  await settle()
  assert.equal(f.state.processes.length, 1)
  f.api.stopClipWatch()
  assert.equal(f.state.processes.filter((proc) => !proc.killed).length, 0)
})

await test('旧 helper 的 stdout 与退出回调不能停止或重启新实例', async () => {
  const f = fixture()
  const old = await start(f)
  const oldExit = old.listeners('exit')[0]
  f.api.stopClipWatch()
  const current = await start(f)
  hit(old)
  old.stdout.emit('data', '{"type":"unsupported"}\n')
  oldExit(1, null)
  assert.equal(f.state.requests.length, 0)
  assert.equal(Boolean(current.killed), false)
  assert.equal(f.state.timers.size, 0)
  hit(current)
  assert.equal(f.state.requests.length, 1)
  f.state.requests[0].resolve(items)
  await settle()
  assert.equal(f.state.writes, 1)
  f.api.stopClipWatch()
})

await test('当前 helper 异常退出仍会按退避定时重启并处理内容', async () => {
  const f = fixture()
  const proc = await start(f)
  proc.emit('exit', 1, null)
  assert.equal(f.state.timers.size, 1)
  const [timer, restart] = [...f.state.timers][0]
  f.state.timers.delete(timer)
  restart()
  await settle()
  assert.equal(f.state.processes.length, 2)
  hit(f.state.processes[1])
  assert.equal(f.state.requests.length, 1)
  f.state.requests[0].resolve(items)
  await settle()
  assert.equal(f.state.writes, 1)
  f.api.stopClipWatch()
  assert.equal(f.state.processes[1].killed, true)
})

process.exitCode = failed ? 1 : 0
