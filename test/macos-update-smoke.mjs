import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import * as paths from 'node:path'
import * as shared from '../src/shared/update-state.ts'

const compiled = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText
function evaluate(code, dependencies, globals = {}) {
  const exports = {}
  vm.runInNewContext(code, { exports, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Missing test dependency: ${name}`)
    return dependencies[name]
  }, Buffer, URL, console, setInterval, clearInterval, setTimeout, clearTimeout, ...globals })
  return exports
}
const stable = { channel: 'stable', repository: shared.UPDATE_REPOSITORY, appId: shared.PRODUCTION_APP_ID,
  feedUrl: shared.MAC_UPDATE_FEED, publicKey: Buffer.alloc(32, 7).toString('base64') }
const config = evaluate(compiled('../src/main/updating/config.ts'), {
  electron: { app: {} }, fs: { realpathSync: (path) => '/private' + path }, path: paths,
  os: { tmpdir: () => '/var/folders/test/user/T' }, '../../shared/update-state': shared
})
assert.equal(config.validateUpdateConfig(stable), stable)
for (const patch of [
  { repository: 'someone/else' }, { publicKey: '' }, { channel: 'beta' },
  { profileDir: '/tmp/guzi-update-x' }, { feedUrl: 'https://example.com/appcast.xml' }, { appId: 'other.app' }
]) assert.throws(() => config.validateUpdateConfig({ ...stable, ...patch }))
const testConfig = { ...stable, channel: 'test', appId: 'cn.shilong.gooz.update-test.fixture',
  feedUrl: 'http://127.0.0.1:8100/appcast.xml', profileDir: '/private/tmp/guzi-update-fixture/profile' }
assert.equal(config.validateUpdateConfig(testConfig), testConfig)
assert.equal(config.validateUpdateConfig({ ...testConfig, profileDir: '/private/var/folders/test/user/T/guzi-update-fixture' }).channel, 'test')
assert.equal(config.validateUpdateConfig({ ...testConfig, profileDir: '/var/folders/test/user/T/guzi-update-fixture' }).channel, 'test')
for (const patch of [{ appId: shared.PRODUCTION_APP_ID }, { profileDir: '/Users/example' },
  { profileDir: '/tmp/guzi-update-test/../../real' }, { feedUrl: 'http://example.com/feed.xml' }]) {
  assert.throws(() => config.validateUpdateConfig({ ...testConfig, ...patch }))
}

const serviceSource = compiled('../src/main/updating/service.ts')
function harness({ exit = 'commit', install = 'success', intent, version = '1.0.0', channel = 'test' } = {}) {
  let native = { phase: 'idle', sessionInProgress: false, ready: false, version: '', displayVersion: '' }
  const app = new EventEmitter()
  Object.assign(app, { getVersion: () => version, getPath: () => '/tmp/guzi-update-unit/profile', getAppPath: () => '/app' })
  const calls = { check: 0, download: 0, install: 0, cancel: 0, exit: 0 }
  const files = new Map(intent ? [['/tmp/guzi-update-unit/profile/update-install.json', JSON.stringify(intent)]] : [])
  const bridge = {
    start: () => true,
    check() { calls.check++; native = { ...native, phase: 'available', sessionInProgress: true, ready: false, version: '2.0.0', displayVersion: '2.0.0' }; return true },
    download() { calls.download++; native = { ...native, phase: 'ready', ready: true }; return true },
    cancel() { calls.cancel++; native = { ...native, phase: 'cancelled', sessionInProgress: false, ready: false } },
    status: () => JSON.stringify(native),
    install() {
      calls.install++
      if (install === 'throw') throw new Error('fixture install failed')
      if (install === 'refuse') return false
      native = { ...native, phase: 'installing', ready: false }
      queueMicrotask(() => app.emit('before-quit'))
      return true
    }
  }
  const service = evaluate(serviceSource, {
    electron: { app }, module: { createRequire: () => () => bridge }, path: paths,
    fs: {
      readFileSync: (p) => { if (files.has(p)) return files.get(p); throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      writeFileSync: (p, data) => files.set(p, data), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a) }
    }, '../windows': { broadcast: () => {} }, './config': { getUpdateBuildConfig: () => ({ channel }) }
  }, { process: { platform: 'darwin', resourcesPath: '/app/Contents/Resources' } })
  service.bootstrapUpdater(async (_reason, commit) => {
    calls.exit++
    if (exit === 'cancel') { await service.cancelPendingUpdate(); return { status: 'cancelled' } }
    if (exit === 'fail') { await service.cancelPendingUpdate(); return { status: 'failed', message: '保存失败' } }
    try { await commit(); return { status: 'committed' } }
    catch (error) { await service.cancelPendingUpdate(); return { status: 'failed', message: error.message } }
  })
  return { service, calls, app, files, setNative: (patch) => { native = { ...native, ...patch } } }
}
async function ready(h) {
  assert.equal((await h.service.checkMacUpdates()).phase, 'available')
  await h.service.downloadMacUpdate()
  await h.service.checkMacUpdates()
  assert.equal(h.service.getUpdateState().phase, 'ready')
}
for (const exit of ['cancel', 'fail']) {
  const h = harness({ exit })
  await ready(h)
  const result = await h.service.installMacUpdate()
  assert.equal(h.calls.install, 0)
  assert.equal(h.calls.cancel, 1)
  assert.equal(result.phase, exit === 'cancel' ? 'available' : 'error')
  assert.equal(h.files.size, 0)
  await h.service.downloadMacUpdate()
  assert.equal(h.calls.check, 2, 'retry must reacquire a verified Sparkle session')
  await h.service.cancelPendingUpdate()
}
{
  const h = harness()
  await ready(h)
  await h.service.cancelPendingUpdate()
  assert.equal(h.calls.install, 0, 'ordinary quit cancellation must never install')
  assert.equal(h.service.getUpdateState().phase, 'available')
}
for (const install of ['throw', 'refuse', 'success']) {
  const h = harness({ install })
  await ready(h)
  const result = await h.service.installMacUpdate()
  assert.equal(h.calls.install, 1)
  assert.equal(h.app.listenerCount('before-quit'), 0, 'installer listener must be cleaned up')
  assert.equal(result.phase, install === 'success' ? 'installing' : 'error')
  assert.equal(result.lastInstalledVersion, undefined, 'requesting install is not successful installation')
  const intent = JSON.parse(h.files.get('/tmp/guzi-update-unit/profile/update-install.json'))
  assert.equal(intent.targetVersion, '2.0.0')
  assert.equal(intent.completed, undefined)
}
{
  const intent = { targetVersion: '2.0.0', requestedAt: 'test' }
  assert.match(harness({ intent }).service.getUpdateState().message, /尚未完成/)
  assert.equal(harness({ intent, version: '2.0.0' }).service.getUpdateState().lastInstalledVersion, '2.0.0')
}
{
  const h = harness({ channel: 'stable' })
  h.setNative({ phase: 'available', sessionInProgress: true, version: '2.0.0-beta.1', displayVersion: '2.0.0-beta.1' })
  await h.service.downloadMacUpdate()
  assert.equal(h.calls.download, 0)
  assert.equal(h.calls.cancel, 1)
}
console.log('macOS update config isolation, save gate, retry, cancellation, installer failure and restart confirmation passed')
