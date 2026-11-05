import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import { desktopPlatform, formatAccelerator, permissionLabel } from '../src/shared/platform.ts'

const require = createRequire(import.meta.url)
function loadTs(file, dependencies, platform = 'win32', globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => dependencies[name] ?? require(name),
    process: { platform, env: { SystemRoot: 'C:\\Windows' } },
    __dirname: 'C:\\Guzi\\out\\main', console,
    setTimeout, clearTimeout, setInterval, clearInterval, ...globals
  })
  return module.exports
}

const { win32, posix } = require('node:path')
for (const name of ['activity-timeline-db-smoke.mjs', 'usage-sampler-smoke.mjs', 'task-chain-demo-smoke.mjs', 'history-service-demo-smoke.mjs', 'real-model-demo.mjs']) {
  const source = readFileSync(new URL(name, import.meta.url), 'utf8')
  const expression = source.match(/let target\s*=\s*([^\n]+)/)?.[1]
  assert(expression, `Missing module resolver in ${name}`)
  for (const [spec, expected] of [['../parser', 'src/main/parser'], ['./tasks', 'src/main/db/tasks'], ['@shared/types', 'src/shared/types']]) {
    const target = vm.runInNewContext(expression, { spec, name: 'src/main/db/connection.ts', posix, resolve: win32.resolve, dirname: win32.dirname })
    assert.equal(target, expected, `${name} must preserve logical module paths under Windows path semantics`)
  }
}

assert.equal(formatAccelerator('CommandOrControl+Alt+K', 'win32'), 'Ctrl+Alt+K')
assert.equal(formatAccelerator('Super+Shift+K', 'win32'), 'Win+Shift+K')
assert.equal(formatAccelerator('CommandOrControl+Alt+K', 'darwin'), '⌘ ⌥ K')
assert.equal(permissionLabel('not-determined'), '尚未请求')
assert.equal(permissionLabel('unsupported'), '系统不支持查询')
assert.match(permissionLabel('unknown'), /无法预先确认/)

const calls = []
const registry = new Map()
const execFile = (file, args, options, callback) => {
  calls.push({ file, args, options })
  const [operation, key] = args
  if (operation === 'add') {
    const value = args.includes('/ve') ? '' : args[args.indexOf('/v') + 1]
    registry.set(`${key}|${value}`, args[args.indexOf('/d') + 1])
    callback(null, { stdout: '' })
  } else if (operation === 'query') {
    const value = registry.get(`${key}|`)
    const matches = value !== undefined && (!args.includes('/f') || args[args.indexOf('/f') + 1] === value)
    callback(matches ? null : new Error('not found'), { stdout: value ?? '' })
  } else if (operation === 'delete') {
    for (const entry of registry.keys()) if (entry.startsWith(`${key}|`) || entry.startsWith(`${key}\\`)) registry.delete(entry)
    callback(null, { stdout: '' })
  }
}
const integration = loadTs('../src/main/platform/windows-integration.ts', { child_process: { execFile } })
assert.equal(calls.length, 0, 'loading the module must not change the registry')
const exe = 'C:\\Users\\A & B\\谷子助手\\谷子助手.exe'
assert.equal(integration.explorerCommand(exe), `"${exe}" --guzi-capture-file "%1"`)
assert.throws(() => integration.explorerCommand('relative.exe'))
assert.throws(() => integration.explorerCommand('C:\\bad"name.exe'))
assert.deepEqual(Array.from(integration.explorerFilesFromArgv(['app.exe', '--guzi-capture-file', 'C:\\A B\\a.txt'])), ['C:\\A B\\a.txt'])
assert.equal(integration.explorerFilesFromArgv(['app.exe', 'C:\\a.txt']).length, 0)
assert.equal(integration.explorerFilesFromArgv(['app.exe', '--guzi-capture-file', 'C:\\a.txt', '--extra']).length, 0)
for (const invalid of [undefined, null, true, 7, 'argv', [], {}, { argv: null }, { argv: 'app.exe' }, { argv: [exe, 7] }, { argv: [exe, null] }, { argv: new Array(3) }]) {
  assert.equal(integration.windowsSecondInstanceArgv(invalid).length, 0, 'second-instance payload must contain only string arguments')
}
assert.deepEqual(Array.from(integration.windowsSecondInstanceArgv({ argv: [exe, '--guzi-capture-file', 'C:\\a.txt'] })), [exe, '--guzi-capture-file', 'C:\\a.txt'])
assert.equal(await integration.windowsIntegrationInstalled(exe), false)
assert.equal(await integration.installWindowsIntegration(exe), true)
assert.equal(await integration.windowsIntegrationInstalled(exe), true)
assert.equal(await integration.windowsIntegrationInstalled('C:\\other.exe'), false)
assert.ok(calls.every(({ file, options }) => file === 'C:\\Windows\\System32\\reg.exe' && options.windowsHide && !options.shell))
assert.ok(calls.every(({ args }) => args[1].startsWith('HKCU\\Software\\Classes\\SystemFileAssociations\\.')))
assert.ok(calls.filter(({ args }) => args[0] === 'add' && args[1].endsWith('\\command')).every(({ args }) => args[args.indexOf('/d') + 1] === integration.explorerCommand(exe)))
registry.set('HKCU\\Unrelated|', 'keep')
assert.equal(await integration.uninstallWindowsIntegration(), true)
assert.equal(registry.size, 1)
assert.equal(registry.get('HKCU\\Unrelated|'), 'keep')
assert.equal(await integration.windowsIntegrationInstalled(exe), false)

function mainModule(platform, argv, lockGranted = true) {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022)
  const dependencies = {}
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const exports = dependencies[statement.moduleSpecifier.text] = {}
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) exports[(binding.propertyName ?? binding.name).text] = () => {}
    }
  }
  const ready = []
  const lockCalls = []
  const submissions = []
  const warnings = []
  const realPaths = new Map()
  let focused = 0
  let quit = 0
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    setPath() {}, getPath: () => 'C:\\Users\\A', setAppUserModelId() {},
    requestSingleInstanceLock: (...args) => { lockCalls.push(args); return lockGranted },
    quit() { quit++ },
    whenReady: () => ({ then(callback) { ready.push(callback) } })
  })
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
  }
  Object.assign(dependencies, {
    electron: { app, dialog: { async showMessageBox(options) { warnings.push(options) } }, Menu: { buildFromTemplate() {} }, Tray, nativeTheme: {}, nativeImage: { createFromPath: () => ({}) } },
    fs: { existsSync: () => true, realpathSync: (file) => realPaths.get(file) ?? file, statSync: () => ({ isFile: () => true }) },
    path: platform === 'win32' ? win32 : posix,
    '@shared/safe-path': loadTs('../src/shared/safe-path.ts', { os: { homedir: () => 'C:\\Users\\A' } }, platform),
    './platform/windows-integration': integration,
    './db': { initDb() {}, getSettings: () => ({ theme: 'system' }) },
    './capture': { async submitExternalFiles(files) { submissions.push(Array.from(files)) } },
    './windows': { appState: {}, createMainWindow() {}, focusMain() { focused++ } }
  })
  loadTs('../src/main/index.ts', dependencies, platform, { process: { platform, argv, env: {} } })
  return {
    app, lockCalls, submissions, warnings, realPaths,
    get focused() { return focused }, get quit() { return quit },
    async start() { await ready.shift()() },
    async secondInstance(rewrittenArgv, additionalData) {
      app.emit('second-instance', {}, rewrittenArgv, 'C:\\Users\\A', additionalData)
      await ready.pop()()
    }
  }
}

const file = 'C:\\Users\\A\\Downloads\\GuziWinTest-file-notice.txt'
const rawArgv = [exe, '--guzi-capture-file', file]
const rewrittenArgv = [exe, '--guzi-capture-file', '--allow-file-access-from-files', file]
assert.equal(integration.explorerFilesFromArgv(rewrittenArgv).length, 0, 'Chromium-injected arguments must not loosen the file parser')
const primary = mainModule('win32', [exe])
await primary.start()
await primary.secondInstance(rewrittenArgv, { argv: rawArgv })
assert.deepEqual(primary.submissions, [[file]], 'second-instance must submit the original argv despite Chromium argument injection')
assert.equal(primary.warnings.length, 0)
assert.equal(primary.focused, 0)

for (const invalid of [undefined, null, {}, { argv: 'app.exe' }, { argv: [exe, '--guzi-capture-file', file, 7] }]) {
  await primary.secondInstance(rawArgv, invalid)
}
assert.deepEqual(primary.submissions, [[file]], 'invalid or missing payloads must never fall back to Electron argv')
assert.equal(primary.warnings.length, 0)
assert.equal(primary.focused, 5)
for (const args of [[...rawArgv, '--extra'], rewrittenArgv]) {
  await primary.secondInstance(rawArgv, { argv: args })
}
assert.deepEqual(primary.submissions, [[file]], 'extra arguments in the original argv must still be rejected')
assert.equal(primary.warnings.length, 2)

await primary.secondInstance(rewrittenArgv, { argv: [exe, '--guzi-capture-file', 'C:\\Users\\A\\AppData\\secret.txt'] })
primary.realPaths.set(file, 'C:\\Windows\\secret.txt')
await primary.secondInstance(rewrittenArgv, { argv: rawArgv })
assert.deepEqual(primary.submissions, [[file]], 'payload handoff must preserve both original and resolved path checks')
assert.equal(primary.warnings.length, 4)

const firstFileStartup = mainModule('win32', rawArgv)
assert.deepEqual(firstFileStartup.lockCalls.map((args) => ({ argv: Array.from(args[0].argv) })), [{ argv: rawArgv }])
await firstFileStartup.start()
assert.deepEqual(firstFileStartup.submissions, [[file]], 'first startup must continue to use process.argv')
const secondary = mainModule('win32', rawArgv, false)
assert.deepEqual(secondary.lockCalls.map((args) => ({ argv: Array.from(args[0].argv) })), [{ argv: rawArgv }])
assert.equal(secondary.quit, 1, 'the second process must quit after handing off its argv')
const macMain = mainModule('darwin', [exe])
assert.deepEqual(macMain.lockCalls, [[]], 'macOS must retain its existing lock call')
await macMain.secondInstance(rawArgv, { argv: rawArgv })
assert.equal(macMain.focused, 1)
assert.equal(macMain.submissions.length, 0)

function windowsModule(platform) {
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.visible = false; this.minimized = false; this.webContents = Object.assign(new EventEmitter(), { send() {} }) }
    isDestroyed() { return false }
    isVisible() { return this.visible }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false; this.restored = true }
    show() { this.visible = true }
    hide() { this.visible = false }
    focus() { this.focused = true }
    loadFile() {}
    loadURL() {}
    setBackgroundColor() {}
  }
  const electron = { BrowserWindow: Window, app: { isPackaged: true }, nativeTheme }
  return loadTs('../src/main/windows.ts', {
    electron,
    './pet/pet-window': { getPetBadgeBounds: () => null },
    './content-lifecycle': { isContentResetting: () => false },
    './platform/window-options': loadTs('../src/main/platform/window-options.ts', { electron }, platform),
    './window-fade': loadTs('../src/main/window-fade.ts', {}, platform, { WeakMap }),
    './window-ready': loadTs('../src/main/window-ready.ts', {}, platform, { WeakMap, WeakSet })
  }, platform)
}
const windows = windowsModule('win32')
const win = windows.createMainWindow(false)
assert.equal(win.options.titleBarStyle, undefined, 'Windows must retain native usable frame controls')
assert.equal(win.options.trafficLightPosition, undefined)
win.emit('ready-to-show')
assert.equal(win.visible, false, 'login startup must stay hidden')
windows.focusMain()
assert.equal(win.visible, true)
let prevented = false
win.emit('close', { preventDefault() { prevented = true } })
assert.equal(prevented, true)
assert.equal(win.visible, false, 'close must preserve the background application')
win.visible = true
win.minimized = true
windows.toggleMainWindow()
assert.equal(win.restored, true)
assert.equal(win.visible, true)
windows.appState.quitting = true
prevented = false
win.emit('close', { preventDefault() { prevented = true } })
assert.equal(prevented, false, 'explicit quit must allow shutdown')
const macWin = windowsModule('darwin').createMainWindow()
assert.equal(macWin.options.titleBarStyle, 'hiddenInset')
assert.equal(macWin.options.trafficLightPosition.x, 18)
let bridge
loadTs('../src/preload/index.ts', {
  electron: {
    contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'guziAssistant'); bridge = api } },
    ipcRenderer: { sendSync: () => 7, invoke: async () => true }, webUtils: { getPathForFile: () => 'C:\\a.txt' }
  },
  '../shared/ipc-channels': { INVOKE_CHANNELS: ['quickaction:status'], EVENT_CHANNELS: [], CONTENT_EPOCH_CHANNEL: 'epoch' },
  '../shared/plugin-manifest': { parsePluginChannel: () => null },
  '../shared/plugin-registry': { PLUGINS: [] },
  '../shared/platform': { desktopPlatform }
})
assert.equal(bridge.platform, 'win32')
assert.equal(Object.isFrozen(bridge), true)
assert.throws(() => { bridge.platform = 'darwin' })
assert.equal(await bridge.invoke('quickaction:status'), true)
await assert.rejects(bridge.invoke('unregistered-channel'))

const timers = new Set()
const prefs = { position: { x: 100, y: 100 }, scale: 0.5, paused: false, enabled: true, dock: null }
let cursor = { x: 0, y: 0 }
class PetWindow extends EventEmitter {
  constructor(options) { super(); this.options = options; this.visible = false; this.webContents = Object.assign(new EventEmitter(), { send() {} }); this.ignoreCalls = [] }
  isDestroyed() { return false }
  isVisible() { return this.visible }
  getBounds() { return { x: 100, y: 100, width: 340, height: 420 } }
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents(ignore) { this.ignoreCalls.push(ignore) }
  showInactive() { this.visible = true; this.emit('show') }
  loadFile() {}
}
const pet = loadTs('../src/main/pet/pet-window.ts', {
  electron: { BrowserWindow: PetWindow, ipcMain: new EventEmitter(), nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }), screen: { getCursorScreenPoint: () => cursor } },
  fs: { mkdirSync() {}, writeFileSync() {} },
  './reaction-mapping': { PET_ART_WIDTH: 192, PET_ART_HEIGHT: 208 },
  './state': { getPetPrefs: () => prefs },
  './paths': { petPreloadPath: () => '/mock/preload.js', petMarkPath: () => '/mock/mark.png', petUserDataDir: () => '/mock/pet' }
}, 'win32', {
  setTimeout: (callback) => { const timer = { callback, unref() {} }; timers.add(timer); return timer },
  clearTimeout: (timer) => timers.delete(timer)
})
const petWin = pet.createPetWindow({ onClick() {}, onDblClick() {} })
assert.equal(petWin.ignoreCalls.at(-1), true, 'outside badge should pass clicks through')
cursor = { x: 270, y: 450 }
const poll = [...timers][0]
timers.delete(poll)
poll.callback()
assert.equal(petWin.ignoreCalls.at(-1), false, 'main-process cursor poll must restore interaction without forwarded mousemove')
petWin.webContents.emit('did-finish-load')
assert.equal(petWin.ignoreCalls.at(-1), false, 'reload must rearm interactivity even if the cursor has not moved')
petWin.emit('hide')
assert.equal(timers.size, 0, 'hidden pet must stop cursor polling')
console.log('Windows shell, Explorer integration, platform bridge and pet interaction passed')
