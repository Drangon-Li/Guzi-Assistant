import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const code = ts.transpileModule(readFileSync(new URL('../src/main/pet/pet-window.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function petModule({ platform = 'win32', enabled = true, readyDuringLoad = false, loadError = null } = {}) {
  const prefs = { position: { x: 100, y: 100 }, scale: 0.3, paused: false, enabled, dock: null }
  const timers = new Set()
  const logs = []
  let nextId = 0
  class PetWindow extends EventEmitter {
    constructor(options) {
      super()
      this.id = ++nextId
      this.options = options
      this.visible = false
      this.destroyed = false
      this.showCalls = 0
      this.webContents = Object.assign(new EventEmitter(), { send() {} })
    }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    getBounds() { return { x: 100, y: 100, width: 340, height: 420 } }
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    showInactive() { this.showCalls++; this.visible = true; this.emit('show') }
    hide() { this.visible = false; this.emit('hide') }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed') }
    loadFile() {
      if (readyDuringLoad) this.emit('ready-to-show')
      return loadError ? Promise.reject(loadError) : Promise.resolve()
    }
  }
  const dependencies = {
    electron: {
      BrowserWindow: PetWindow,
      ipcMain: new EventEmitter(),
      nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
      screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }
    },
    fs: { mkdirSync() {}, writeFileSync() {} },
    './reaction-mapping': { PET_ART_WIDTH: 192, PET_ART_HEIGHT: 208 },
    './state': { getPetPrefs: () => prefs, savePetPrefs: (patch) => Object.assign(prefs, patch) },
    './paths': { petPreloadPath: () => '/mock/preload.js', petMarkPath: () => '/mock/mark.png', petUserDataDir: () => '/mock/pet' }
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => dependencies[name] ?? require(name),
    process: { platform },
    console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    setTimeout: (callback) => { const timer = { callback, unref() {} }; timers.add(timer); return timer },
    clearTimeout: (timer) => timers.delete(timer)
  })
  const api = module.exports
  return { api, timers, logs, create: () => api.createPetWindow({ onClick() {}, onDblClick() {} }) }
}

const startup = petModule()
const startupWin = startup.create()
assert.equal(startupWin.visible, false, 'Windows must stay hidden before the first rendered frame')
assert.equal(startup.timers.size, 0, 'hidden startup must not poll the cursor')
startupWin.webContents.emit('did-finish-load')
assert.equal(startupWin.visible, false, 'document load alone must not bypass the first-frame gate')
startupWin.emit('ready-to-show')
assert.equal(startupWin.visible, true)
assert.equal(startupWin.showCalls, 1)
assert.equal(startup.timers.size, 1)
startup.api.hidePet()
startupWin.emit('ready-to-show')
assert.equal(startupWin.visible, false, 'later ready events must not reopen a hidden pet')

const showBeforeReady = petModule({ enabled: false })
const showWin = showBeforeReady.create()
showBeforeReady.api.showPet()
assert.equal(showWin.visible, false, 'show requests before the first frame must wait')
showWin.emit('ready-to-show')
assert.equal(showWin.visible, true, 'the first frame must honor a pending show request')

const hideBeforeReady = petModule()
const hideWin = hideBeforeReady.create()
hideBeforeReady.api.hidePet()
hideWin.emit('ready-to-show')
assert.equal(hideWin.visible, false, 'hide before ready must cancel the startup show intent')
hideBeforeReady.api.showPet()
assert.equal(hideWin.visible, true, 'show after ready must remain immediate')

const disabled = petModule({ enabled: false })
const disabledWin = disabled.create()
disabledWin.emit('ready-to-show')
assert.equal(disabledWin.visible, false, 'disabled startup must remain hidden after ready')
assert.equal(disabled.timers.size, 0)

const destroyed = petModule()
const oldWin = destroyed.create()
destroyed.api.destroyPet()
const replacement = destroyed.create()
oldWin.emit('ready-to-show')
assert.equal(oldWin.showCalls, 0, 'a destroyed window must not show from a late ready callback')
assert.equal(replacement.visible, false, 'an old ready callback must not unlock the new window')
replacement.emit('ready-to-show')
assert.equal(replacement.visible, true)
oldWin.emit('closed')
oldWin.emit('hide')
oldWin.webContents.emit('did-finish-load')
assert.equal(destroyed.api.getPetWindow(), replacement)
assert.equal(destroyed.timers.size, 1, 'late callbacks from the old window must not stop the new cursor poll')

const synchronous = petModule({ readyDuringLoad: true })
const synchronousWin = synchronous.create()
assert.equal(synchronousWin.visible, true, 'ready listener must be registered before loadFile starts')
assert.equal(synchronousWin.showCalls, 1, 'ready during loading must not cause duplicate display')

const mac = petModule({ platform: 'darwin' })
const macWin = mac.create()
assert.equal(macWin.visible, true, 'macOS must retain immediate startup display')
mac.api.hidePet()
mac.api.showPet()
assert.equal(macWin.visible, true)
assert.equal(mac.logs.length, 0, 'the added diagnostics must be Windows-only')

const diagnostics = petModule({ loadError: new Error('private content /Users/private-name/secret.txt') })
const diagnosticWin = diagnostics.create()
diagnosticWin.webContents.emit('did-fail-load', {}, -2, 'private content', 'file:///Users/private-name/secret.txt', true)
diagnosticWin.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 })
await Promise.resolve()
assert.deepEqual(diagnostics.logs.map(([message]) => message), ['[pet-window] did-fail-load', '[pet-window] render-process-gone', '[pet-window] loadFile rejected'])
assert.equal(diagnostics.logs[0][1].errorCode, -2)
assert.equal(diagnostics.logs[1][1].reason, 'crashed')
assert.doesNotMatch(JSON.stringify(diagnostics.logs), /private content|private-name|secret\.txt/, 'diagnostics must not log file paths or error contents')

console.log('Windows pet first-frame display, visibility intent, lifecycle guards and diagnostics passed')
