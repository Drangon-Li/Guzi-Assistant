import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const compiled = new Map()
function load(name, mocks = {}, fallback) {
  if (!compiled.has(name)) compiled.set(name, ts.transpileModule(
    readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }
  ).outputText)
  const exports = {}
  vm.runInNewContext(compiled.get(name), {
    exports, console: { ...console, warn() {} },
    require: (id) => {
      if (id in mocks) return mocks[id]
      assert.ok(fallback, `Unexpected ${name} dependency: ${id}`)
      return fallback(id)
    }
  }, { filename: `${name}.ts` })
  return exports
}

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const noop = () => {}
const unused = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : noop })

function fixture() {
  const lifecycle = load('main/content-lifecycle')
  const contentIpc = load('main/content-ipc', { './content-lifecycle': lifecycle })
  const channels = load('shared/ipc-channels')
  const manifest = load('shared/plugin-manifest')
  const registry = load('shared/plugin-registry')
  const handlers = new Map()
  const mainListeners = new Map()
  const writes = []
  const reloadEpochs = []
  const assistant = deferred()
  const pluginRead = deferred()
  let wipeCount = 0
  const record = (action) => (...args) => { writes.push({ action, args: structuredClone(args) }); return true }
  const ipcMain = {
    handle: (channel, listener) => {
      assert.equal(handlers.has(channel), false, `Duplicate handler: ${channel}`)
      handlers.set(channel, listener)
    },
    removeHandler: (channel) => handlers.delete(channel),
    on: (channel, listener) => {
      if (!mainListeners.has(channel)) mainListeners.set(channel, [])
      mainListeners.get(channel).push(listener)
    }
  }
  const electron = {
    ipcMain,
    app: { getPath: () => '/fixture-only', getVersion: () => '0.11.0' },
    nativeTheme: { on: noop },
    BrowserWindow: { getAllWindows: () => [false, true, false].map((destroyed) => ({
      isDestroyed: () => destroyed,
      webContents: { reload: () => {
        assert.equal(lifecycle.isContentResetting(), false)
        reloadEpochs.push(lifecycle.captureContentEpoch())
      } }
    })) }
  }
  const pluginMocks = {
    electron, '@shared/plugin-manifest': manifest, '@shared/plugin-registry': registry,
    '../content-ipc': contentIpc,
    '../db/plugins.ts': { readEnabledPlugins: () => ['notebook'] }
  }
  for (const id of ['achievement', 'habit', 'notebook', 'pomodoro', 'timeblock']) {
    pluginMocks[`./${id}/index.ts`] = { __esModule: true, default: {
      id, handlers: id === 'notebook' ? { update: record('plugin:update'), get: () => pluginRead.promise } : {}
    } }
  }
  const plugins = load('main/plugins/index', pluginMocks, () => unused)
  const reset = load('main/data-reset', {
    electron, './content-lifecycle': lifecycle, './plugins/index': plugins,
    './db/maintenance': { wipeAll: () => { wipeCount++; writes.length = 0 } },
    './content-files': { clearUserContentFiles: async (directory) => assert.equal(directory, '/fixture-only') },
    './history/service': { acquireHistoryMutationBarrier: () => noop, clearHistory: noop, stopHistoryPersistence: noop }
  }, () => unused)
  load('main/ipc', {
    electron, './content-lifecycle': lifecycle, './content-ipc': contentIpc,
    '@shared/ipc-channels': channels, './plugins/index.ts': plugins, './data-reset': reset,
    './db': { saveChatMessages: record('chat:save'), clearChatMessages: record('chat:clear') },
    './assistant': { assistantChat: () => assistant.promise },
    './windows': { broadcastExcept: noop }
  }, () => unused).registerIpc()

  const event = { sender: { id: 42 } }
  const invoke = async (channel, ...args) => {
    assert.ok(handlers.has(channel), `No handler: ${channel}`)
    return handlers.get(channel)(event, ...args)
  }
  const renderer = () => {
    let api
    const syncCalls = []
    const invokeCalls = []
    const sends = []
    const listeners = new Map()
    const ipcRenderer = {
      sendSync: (channel) => {
        syncCalls.push(channel)
        const syncEvent = { ...event }
        for (const listener of mainListeners.get(channel) ?? []) listener(syncEvent)
        return syncEvent.returnValue
      },
      invoke: (channel, ...args) => {
        invokeCalls.push({ channel, args: structuredClone(args) })
        return invoke(channel, ...args)
      },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel) },
      send: (channel, ...args) => {
        sends.push({ channel, args: structuredClone(args) })
        for (const listener of mainListeners.get(channel) ?? []) listener(event, ...args)
      }
    }
    return {
      electron: {
        ipcRenderer, webUtils: { getPathForFile: (file) => file.path },
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'guziAssistant'); api = value } }
      },
      api: () => api, syncCalls, invokeCalls, sends, listeners
    }
  }
  const preload = () => {
    const r = renderer()
    load('preload/index', {
      electron: r.electron, '../shared/ipc-channels': channels,
      '../shared/plugin-manifest': manifest, '../shared/plugin-registry': registry
    })
    return { ...r, api: r.api() }
  }
  load('main/pet/pet-chat-window', {
    electron, '../content-lifecycle': lifecycle,
    '../capture': { extractPetDropText: async () => null, submitExternalFiles: record('pet:files') }
  }, () => unused)
  const petPreload = () => {
    const r = renderer()
    const domListeners = new Map()
    vm.runInNewContext(readFileSync(new URL('../resources/pet/pet-preload.cjs', import.meta.url), 'utf8'), {
      require: (id) => { assert.equal(id, 'electron'); return r.electron },
      document: {
        readyState: 'complete',
        addEventListener: (name, listener) => domListeners.set(name, listener),
        documentElement: { classList: { add: noop, remove: noop } }
      }
    }, { filename: 'pet-preload.cjs' })
    return { ...r, drop: () => domListeners.get('drop')({
      preventDefault: noop, dataTransfer: { files: [{ path: '/fixture-only/note.txt' }] }
    }) }
  }
  return { preload, petPreload, lifecycle, channels, writes, reloadEpochs, assistant, pluginRead,
    invoke, wipeCount: () => wipeCount }
}

async function test(name, run) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { process.exitCode = 1; console.error(`✗ ${name}: ${error.stack}`) }
}

await test('preload只捕获一次版本，信封被实际chat/plugin处理器剥离', async () => {
  const f = fixture()
  const page = f.preload()
  await page.api.invoke('chat:save', 'assistant', [{ role: 'user', content: 'current' }])
  await page.api.invoke('plugin:notebook:update', 'note-1', { content: 'current' })
  assert.deepEqual(page.syncCalls, [f.channels.CONTENT_EPOCH_CHANNEL])
  assert.equal(page.invokeCalls[0].args[0].contentEpoch, f.lifecycle.captureContentEpoch())
  assert.deepEqual(f.writes, [
    { action: 'chat:save', args: ['assistant', [{ role: 'user', content: 'current' }]] },
    { action: 'plugin:update', args: ['note-1', { content: 'current' }] }
  ])
})

await test('清空释放后旧preload永久失效，不能再次保存聊天或插件内容', async () => {
  const f = fixture()
  const old = f.preload()
  await old.api.invoke('data:wipe')
  await assert.rejects(old.api.invoke('chat:save', 'assistant', [{ content: 'old' }]), /已失效/)
  await assert.rejects(old.api.invoke('chat:clear', 'assistant'), /已失效/)
  await assert.rejects(old.api.invoke('plugin:notebook:update', 'note-1', { content: 'old' }), /已失效/)
  assert.equal(f.writes.length, 0)
  assert.equal(old.syncCalls.length, 1)
})

await test('实际主进程与插件包装拒绝清空前启动的迟到异步结果', async () => {
  const f = fixture()
  const old = f.preload()
  const chat = assert.rejects(old.api.invoke('assistant:chat', { history: [], candidates: null }), /已失效/)
  const note = assert.rejects(old.api.invoke('plugin:notebook:get', 'note-1'), /已失效/)
  await old.api.invoke('data:wipe')
  f.assistant.resolve({ reply: 'old result' })
  f.pluginRead.resolve({ id: 'note-1', content: 'old result' })
  await Promise.all([chat, note])
})

await test('data:wipe允许自身跨版本返回，释放后重载全部存活窗口，新preload可写', async () => {
  const f = fixture()
  const old = f.preload()
  const epoch = f.lifecycle.captureContentEpoch()
  assert.equal(await old.api.invoke('data:wipe'), undefined)
  assert.equal(f.wipeCount(), 1)
  assert.deepEqual(f.reloadEpochs, [epoch + 1, epoch + 1])
  await assert.rejects(old.api.invoke('data:wipe'), /已失效/)
  assert.equal(f.wipeCount(), 1)
  const fresh = f.preload()
  await fresh.api.invoke('chat:save', 'assistant', [{ content: 'new' }])
  await fresh.api.invoke('plugin:notebook:update', 'note-2', { content: 'new' })
  assert.equal(f.writes.length, 2)
  assert.equal(fresh.syncCalls.length, 1)
  assert.equal(fresh.invokeCalls[0].args[0].contentEpoch, epoch + 1)
})

await test('缺失或伪造版本的直接调用失败，重置期间创建的preload同样失败关闭', async () => {
  const f = fixture()
  for (const envelope of [null, {}, { contentEpoch: NaN }, { contentEpoch: 99 }]) {
    await assert.rejects(f.invoke('chat:save', envelope, 'assistant', []), /已失效/)
    await assert.rejects(f.invoke('plugin:notebook:update', envelope, 'note-1', {}), /已失效/)
  }
  const old = f.preload()
  const wiping = old.api.invoke('data:wipe')
  assert.equal(f.lifecycle.isContentResetting(), true)
  const duringReset = f.preload()
  await assert.rejects(duringReset.api.invoke('chat:save', 'assistant', []), /已失效/)
  await wiping
  await assert.rejects(duringReset.api.invoke('plugin:notebook:update', 'note-1', {}), /已失效/)
  assert.equal(f.writes.length, 0)
})

await test('新preload仍拒绝非法通道和事件，内部版本通道不向页面开放', async () => {
  const f = fixture()
  await f.preload().api.invoke('data:wipe')
  const page = f.preload()
  for (const channel of ['forbidden:channel', 'plugin:unknown:update', 'plugin:notebook:update:extra', f.channels.CONTENT_EPOCH_CHANNEL]) {
    await assert.rejects(page.api.invoke(channel), /未授权的 IPC 通道/)
  }
  assert.equal(page.invokeCalls.length, 0)
  page.api.on('forbidden:event', noop)()
  assert.equal(page.listeners.size, 0)
  const unsubscribe = page.api.on('guzi-assistant:chat-updated', noop)
  assert.equal(page.listeners.size, 1)
  unsubscribe()
  assert.equal(page.listeners.size, 0)
  await assert.rejects(page.api.invoke('plugin:habit:update'), /No handler/)
  assert.equal(page.invokeCalls.length, 1)
})

await test('raw桌宠preload拖放携带固定版本，旧桌宠不能在清空后重新注入文件', async () => {
  const f = fixture()
  const old = f.petPreload()
  old.drop()
  await new Promise(setImmediate)
  assert.equal(f.writes[0].action, 'pet:files')
  const first = old.sends.find(({ channel }) => channel === 'openpets:pet-drop-files')
  assert.equal(first.args[0].contentEpoch, f.lifecycle.captureContentEpoch())
  assert.deepEqual(first.args[1], ['/fixture-only/note.txt'])
  await f.preload().api.invoke('data:wipe')
  old.drop()
  await new Promise(setImmediate)
  assert.equal(f.writes.length, 0)
  assert.equal(old.syncCalls.length, 1)
  const fresh = f.petPreload()
  fresh.drop()
  await new Promise(setImmediate)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].action, 'pet:files')
})
