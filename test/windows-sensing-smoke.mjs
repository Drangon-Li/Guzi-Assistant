import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import vm from 'node:vm'
import ts from 'typescript'
import { decideHistoryPrivacy, isBrowserIdentity, isPrivateBrowserWindow } from '../src/main/history/privacy-policy.ts'
import { snapshotSafetyReason } from '../src/main/screen-snapshot.ts'

const require = createRequire(import.meta.url)
const transpile = (file) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const flush = () => new Promise(setImmediate)

{
  let stored = {}
  const mocks = {
    '@shared/api-formats': { normalizeApiFormat: () => 'openai' },
    './connection.ts': { getDb: () => ({ prepare: () => ({ all: () => Object.entries(stored).map(([key, value]) => ({ key, value })) }) }) },
    '../env': { loadEnv: () => ({}) },
    '@shared/env-value': { firstNonBlank: () => '' },
    '@shared/history': { normalizeHistoryHost: (value) => value },
    '@shared/model-configuration': { resolveDirectModelSettings: () => ({}) }
  }
  for (const platform of ['win32', 'darwin']) {
    const context = { exports: {}, process: { platform }, require: (name) => {
      assert.ok(name in mocks, `Unexpected settings dependency: ${name}`)
      return mocks[name]
    } }
    vm.runInNewContext(transpile('../src/main/db/settings.ts'), context)
    stored = {}
    assert.equal(context.exports.getSettings().clipWatchEnabled, platform === 'darwin')
    for (const enabled of [true, false]) {
      stored = { clipWatchEnabled: String(enabled) }
      assert.equal(context.exports.getSettings().clipWatchEnabled, enabled, 'preserve the explicit user choice')
    }
  }
}
console.log('✓ Windows clipboard defaults to opt-in while preserving macOS defaults and saved choices')

function processFixture() {
  const proc = new EventEmitter()
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = () => { proc.killed = true }
  return proc
}

{
  const children = []
  const executions = []
  const application = new EventEmitter()
  application.getAppPath = () => '/project'
  application.isPackaged = false
  const mocks = {
    'node:path': require('node:path'),
    electron: { app: application },
    'node:child_process': {
      spawn: (path, args, options) => {
        const child = processFixture()
        children.push({ child, path, args, options })
        return child
      },
      execFile: (path, args, options, callback) => {
        const child = processFixture()
        children.push({ child, path, args, options })
        executions.push((error = null) => { callback(error, '[]') })
        return child
      }
    }
  }
  const context = { exports: {}, process: { resourcesPath: '/resources', pid: 789 }, require: (name) => {
    assert.ok(name in mocks, `Unexpected bridge dependency: ${name}`)
    return mocks[name]
  } }
  vm.runInNewContext(transpile('../src/main/platform/windows-helper.ts'), context)
  const bridge = context.exports
  assert.match(bridge.windowsHelperPath(), /project[/\\]build[/\\]native[/\\]GuziWindowsHelper\.exe$/)
  application.isPackaged = true
  assert.match(bridge.windowsHelperPath(), /resources[/\\]native[/\\]GuziWindowsHelper\.exe$/)
  const collector = bridge.spawnWindowsHelper('collect')
  assert.deepEqual([...children[0].args], ['collect', '--parent-pid', '789'])
  assert.equal(children[0].options.windowsHide, true)
  const clipboard = bridge.spawnWindowsHelper('clipboard-watch')
  const request = bridge.execWindowsHelper(['clipboard-files'], { timeout: 1234 })
  assert.equal(children.at(-1).options.timeout, 1234)
  executions.pop()()
  let resolved = false
  void request.then(() => { resolved = true })
  await flush()
  assert.equal(resolved, false, 'native file handles can remain open until close')
  children.at(-1).child.emit('close', 0)
  assert.equal(await request, '[]')
  const abortedRequest = bridge.execWindowsHelper(['capture-window', '123', '/tmp/out.png'])
  const abortedChild = children.at(-1).child
  const abortError = new Error('AbortError')
  executions.pop()(abortError)
  let rejected = false
  void abortedRequest.catch(() => { rejected = true })
  await flush()
  assert.equal(rejected, false, 'abort must wait for native handles to close before unlink')
  abortedChild.emit('close', null)
  await assert.rejects(abortedRequest, /AbortError/)
  application.emit('before-quit')
  assert.equal(collector.killed, true)
  assert.equal(clipboard.killed, true)
  const abort = new AbortController()
  abort.abort()
  assert.throws(() => bridge.execWindowsHelper(['snapshot'], { signal: abort.signal }))
  assert.equal(children.length, 4, 'pre-aborted calls must never spawn a helper')
}
console.log('✓ Windows helper packaged/dev paths, parent lifetime channel, bounded execution, quit cleanup and abort')

{
  const children = [], events = [], health = [], restarts = [], intervals = []
  const snapshot = { observedAtMs: Date.now(), pid: 42, windowId: 12345, name: 'Chrome',
    bundleId: 'win32:chrome.exe:0123456789abcdef', windowTitle: 'Example', accessibility: 'available',
    focusedRole: 'UIA50004', focusedSubrole: 'UIA:focus-a', secureInput: false }
  const commands = []
  const mocks = {
    child_process: { execFile() { throw Error('Windows must not run xcrun') }, spawn() { throw Error('Windows must use packaged helper') } },
    fs: { existsSync: () => true }, path: require('node:path'), util: require('node:util'),
    electron: { app: { getPath: () => '/fixture' } },
    './native-helper-cache.ts': { ensureNativeHelperBinary() { throw Error('Windows must not compile at runtime') } },
    './screen-snapshot.ts': { parseScreenSnapshot: (value) => value, snapshotContext: (value) => value },
    './platform/windows-helper.ts': {
      windowsHelperPath: () => '/native/GuziWindowsHelper.exe',
      execWindowsHelper: async (args) => { commands.push([...args]); return JSON.stringify(snapshot) },
      spawnWindowsHelper: (command) => { assert.equal(command, 'collect'); const proc = processFixture(); children.push(proc); return proc }
    },
    './native/frontmost-collector.m?raw': { default: '' }, './native/frontmost-oneshot.m?raw': { default: '' }
  }
  const context = {
    exports: {}, process: { platform: 'win32' }, Date,
    require: (name) => { assert.ok(name in mocks, `Unexpected collector dependency: ${name}`); return mocks[name] },
    setTimeout: (fn) => { restarts.push(fn); return 1 }, clearTimeout() {},
    setInterval: (fn) => { intervals.push(fn); return 2 }, clearInterval() {}
  }
  vm.runInNewContext(transpile('../src/main/frontapp.ts'), context)
  const handle = context.exports.startFrontmostCollector((event) => events.push(event), (value) => health.push(value))
  await flush()
  assert.equal(children.length, 1)
  const base = { type: 'heartbeat', appName: 'Chrome', bundleId: snapshot.bundleId, windowTitle: '',
    occurredAtMs: Date.now(), accessibility: 'unavailable', privacyState: 'excluded', secureInput: true }
  children[0].stdout.write(JSON.stringify(base).slice(0, 30))
  assert.equal(events.length, 0)
  children[0].stdout.write(JSON.stringify(base).slice(30) + '\n')
  assert.equal(events[0].privacyState, 'excluded')
  assert.equal(health.at(-1).state, 'degraded')
  children[0].stdout.write(JSON.stringify({ ...base, text: 'must never enter activity history' }) + '\n')
  assert.equal(events.length, 1, 'collector rejects raw payload keys')
  const taken = await context.exports.getScreenSnapshot()
  assert.equal(taken.windowId, 12345)
  assert.deepEqual(commands, [['snapshot']])
  children[0].emit('exit', 1, null)
  assert.equal(restarts.length, 1)
  restarts.pop()()
  await flush()
  assert.equal(children.length, 2)
  children[0].stdout.write(JSON.stringify(base) + '\n')
  assert.equal(events.length, 1, 'dead helper output cannot update a new instance')
  handle.stop()
  assert.equal(children[1].killed, true)
  assert.equal(health.at(-1).state, 'stopped')
}
console.log('✓ Windows collector uses packaged commands, enforces protocol privacy, parses JSONL chunks and ignores old instances')

{
  const settings = { clipWatchEnabled: true, screenSenseExcludedApps: [], screenSensePopup: true }
  const children = [], requests = []
  let writes = 0
  class CooldownMap { sweep() {} untilMs() {} start() {} clear() {} }
  const mocks = {
    child_process: { execFile() { throw Error('Windows must not run xcrun') }, spawn() { throw Error('Windows must use packaged helper') } },
    './native/clipboard-detect.m?raw': { default: '' }, electron: { app: { getPath: () => '/fixture' } },
    fs: { existsSync: () => true }, path: require('node:path'), util: require('node:util'),
    '@shared/phash': { textHash: (value) => value }, '@shared/sensitive': { redactSensitive: (text) => ({ text, hits: [] }) },
    '@shared/clip-gate': { CLIP_LIMITS: { cooldownMs: 1 }, decideClipboardFastPath: () => ({ fast: false }), decideClipboardParse: () => ({ run: true }) },
    '@shared/cooldown': { CooldownMap }, './capture': { HINTS: { clipboard_text: 'hint' } }, './db': { getSettings: () => settings },
    './native-helper-cache': { ensureNativeHelperBinary() { throw Error('Windows must not compile') } },
    './platform/windows-helper.ts': { windowsHelperPath: () => '/native/helper.exe', spawnWindowsHelper: (command) => {
      assert.equal(command, 'clipboard-watch')
      const child = processFixture(); children.push(child); return child
    } },
    './parser': { cloudReady: () => true, parseToItems: (input) => new Promise((resolve) => { requests.push({ input, resolve }) }) },
    './pet/controller': { applyExternalPetSay() {} },
    './detection-cards': { buildDetectionCards: () => { writes++; return [] }, buildLocalItem() {}, parsedToExtraction: (item) => item, showDetectedCards() {} },
    './screenwatch': { isWatchPaused: () => false }, './windows': { debugEvent() {}, debugIsOpen: () => false }
  }
  const context = { exports: {}, process: { platform: 'win32' }, AbortController,
    require: (name) => { assert.ok(name in mocks, `Unexpected clipboard dependency: ${name}`); return mocks[name] },
    setTimeout: () => 1, clearTimeout() {}
  }
  vm.runInNewContext(transpile('../src/main/clipwatch.ts'), context)
  context.exports.startClipWatch()
  await flush()
  assert.equal(children.length, 1)
  children[0].stdout.write('{"type":"ready"}\n{"type":"skip","reason":"concealed"}\n{"type":"hit","text":42}\n')
  assert.equal(requests.length, 0)
  const hit = JSON.stringify({ type: 'hit', text: '明天下午3点开会', app: 'Notepad', bundleId: 'win32:notepad.exe:0123456789abcdef' }) + '\n'
  children[0].stdout.write(hit)
  assert.equal(requests.length, 1)
  context.exports.stopClipWatch()
  assert.equal(requests[0].input.signal.aborted, true)
  requests[0].resolve([{ belongs_to_user: 'yes', title: '开会' }])
  await flush()
  assert.equal(writes, 0)
  assert.equal(children[0].killed, true)
  context.exports.startClipWatch()
  await flush()
  children[0].stdout.write(hit)
  assert.equal(requests.length, 1, 'old clipboard helper cannot produce a new request')
  children[1].stdout.write(hit)
  assert.equal(requests.length, 2)
  context.exports.stopClipWatch()
  requests[1].resolve([])
  await flush()
}
console.log('✓ Windows clipboard native command, concealed/malformed filtering, cancellation and stale helper isolation')

{
  let canceled = false
  let dialogOptions
  const calls = []
  const id = 'win32:editor.exe:0123456789abcdef'
  const mocks = {
    'node:child_process': { execFile() { throw Error('Windows picker must not use plutil') } },
    'node:fs': { existsSync: () => true }, 'node:path': require('node:path'), 'node:util': require('node:util'),
    electron: { dialog: { showOpenDialog: async (options) => {
      dialogOptions = options
      return { canceled, filePaths: ['C:\\Apps\\Editor.exe', 'C:\\Apps\\Editor.EXE', 'C:\\Apps\\Shortcut.lnk'] }
    } } },
    '../platform/windows-helper.ts': { execWindowsHelper: async (args) => {
      calls.push([...args])
      return JSON.stringify({ bundleId: id, name: 'Editor', path: 'c:\\apps\\editor.exe' })
    } }
  }
  const context = { exports: {}, process: { platform: 'win32' },
    require: (name) => { assert.ok(name in mocks, `Unexpected picker dependency: ${name}`); return mocks[name] }
  }
  vm.runInNewContext(transpile('../src/main/history/app-picker.ts'), context)
  const chosen = await context.exports.pickHistoryApps()
  assert.equal(chosen.length, 1)
  assert.equal(chosen[0].bundleId, id)
  assert.deepEqual([...dialogOptions.filters[0].extensions], ['exe'])
  assert.ok(calls.every((args) => args[0] === 'app-info'))
  assert.equal(calls.length, 2)
  canceled = true
  assert.equal(await context.exports.pickHistoryApps(), null)
}
console.log('✓ Windows picker selects executables and deduplicates the collector identity')

const windowsChrome = 'win32:chrome.exe:0123456789abcdef'
assert.equal(isBrowserIdentity(windowsChrome), true)
assert.equal(isPrivateBrowserWindow(windowsChrome, 'Example - Incognito'), true)
assert.equal(isPrivateBrowserWindow('win32:editor.exe:0123456789abcdef', 'Private window'), false)
assert.equal(decideHistoryPrivacy({ bundleId: windowsChrome, excludedHosts: ['example.com'] }).persist, false)
assert.equal(decideHistoryPrivacy({ bundleId: windowsChrome, urlHost: 'sub.example.com', excludedHosts: ['example.com'] }).persist, false)
assert.equal(decideHistoryPrivacy({ bundleId: windowsChrome, excludedBundleIds: [windowsChrome.toUpperCase()] }).persist, false)
assert.equal(decideHistoryPrivacy({ appName: 'Google Chrome', bundleId: windowsChrome, excludedApps: ['chrome.exe'] }).persist, false)
assert.equal(decideHistoryPrivacy({ appName: 'Google Chrome', bundleId: windowsChrome, windowTitle: 'InPrivate' }).state, 'private')
const safe = { observedAtMs: Date.now(), pid: 42, windowId: 12345, name: 'Chrome', bundleId: windowsChrome,
  windowTitle: '', accessibility: 'available', focusedRole: 'UIA50004', focusedSubrole: 'UIA:focus', secureInput: false }
assert.equal(snapshotSafetyReason(safe), null)
assert.ok(snapshotSafetyReason({ ...safe, accessibility: 'unavailable', secureInput: null }))
assert.ok(snapshotSafetyReason({ ...safe, secureInput: true }))
console.log('✓ Windows executable browser mapping, blacklist/host policies and secure/unknown snapshot gates')
