import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'

const compile = (file) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const mainCode = compile('../src/main/exit-lifecycle.ts')
const rendererCode = compile('../src/renderer/src/exit-lifecycle.ts')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }

function mainFixture(drafts = [[]], choices = []) {
  const exports = {}, app = new EventEmitter(), appState = { quitting: false }
  const timers = new Map(), events = [], windows = []
  let timerId = 0, serial = 0, prepared = 0, normalCancelled = 0, installCancelled = 0
  let failPrepare = false, ignore = false, crashed = false, cancelFailure = false
  let prepareGate = null
  const lifecycle = { setExitPreparing(value) { events.push(`gate:${value}`) }, flushContentWork: async () => {} }
  app.quit = () => events.push('app.quit')
  vm.runInNewContext(mainCode, { exports, setTimeout(fn) { timers.set(++timerId, fn); return timerId }, clearTimeout(id) { timers.delete(id) },
    require(id) {
      if (id === 'electron') return { app, dialog: { showMessageBox: async () => ({ response: choices.shift() ?? 0 }) } }
      if (id === 'crypto') return { randomUUID: () => `request-${++serial}` }
      if (id === './windows') return { appState, getExitWindows: () => windows }
      if (id === './content-lifecycle') return lifecycle
      throw new Error(`Unexpected dependency ${id}`)
    }
  })
  drafts.forEach((items, index) => {
    const contents = new EventEmitter()
    Object.assign(contents, { id: index + 10, mainFrame: {}, isDestroyed: () => false,
      send(_channel, request) {
        events.push(`${index}:${request.stage}`)
        if (request.stage === 'resume' || ignore) return
        if (crashed) { queueMicrotask(() => contents.emit('render-process-gone')); return }
        queueMicrotask(async () => {
          if (request.stage === 'prepare') { prepared++; if (prepareGate) await prepareGate.promise }
          try { exports.registerExitResponse({ sender: contents, senderFrame: contents.mainFrame }, {
            requestId: request.requestId, stage: request.stage,
            ...(request.stage === 'inspect' ? { drafts: items } : failPrepare ? { error: 'disk full' } : {})
          }) } catch (error) { events.push(error.message) }
        })
      }
    })
    windows.push({ webContents: contents, isDestroyed: () => false })
  })
  exports.installExitLifecycle({
    beforeNormalExit: async () => { normalCancelled++; events.push('cancel.normal'); if (cancelFailure) throw new Error('cancel failed') },
    cancelFailedInstall: async () => { installCancelled++; if (cancelFailure) throw new Error('cancel failed') },
    prepareMain: async () => { events.push('flush.main') }
  })
  return { api: exports, app, appState, events, windows, timers,
    get prepared() { return prepared }, get normalCancelled() { return normalCancelled }, get installCancelled() { return installCancelled },
    failPrepare(value) { failPrepare = value }, setIgnore(value) { ignore = value }, setCrash(value) { crashed = value },
    failCancel(value) { cancelFailure = value }, holdPrepare() { return prepareGate = deferred() } }
}

{
  const f = mainFixture([[{ id: 'note', label: '笔记', canSave: true }]])
  let commits = 0
  const result = await f.api.requestExit('quit', () => { commits++; f.events.push('commit') })
  assert.equal(result.status, 'committed')
  assert.equal(commits, 1)
  assert.equal(f.normalCancelled, 1)
  assert.ok(f.events.indexOf('flush.main') < f.events.indexOf('cancel.normal'))
  assert.ok(f.events.indexOf('cancel.normal') < f.events.indexOf('commit'))
  console.log('✓ 普通退出等待保存，先撤销pending update，再提交退出')
}
{
  const f = mainFixture([[{ id: 'voice', label: '录音', canSave: true }, { id: 'input', label: '草稿', canSave: false }]], [0, 1])
  const result = await f.api.requestExit('install-update', () => assert.fail('cancel must not commit'))
  assert.equal(result.status, 'cancelled')
  assert.equal(f.prepared, 0)
  assert.equal(f.installCancelled, 1)
  assert.equal(f.appState.quitting, false)
  assert.ok(f.events.includes('0:resume'))
  console.log('✓ 收齐决策前不停止录音；后一个草稿取消会恢复全部窗口')
}
{
  const f = mainFixture()
  f.failPrepare(true)
  const failed = await f.api.requestExit('install-update', () => assert.fail('save failure must not commit'))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.message, 'disk full')
  assert.equal(f.installCancelled, 1)
  f.failPrepare(false)
  assert.equal((await f.api.requestExit('install-update', () => {})).status, 'committed')
  console.log('✓ 保存拒绝不退出，恢复后同一进程可以重试')
}
{
  const f = mainFixture()
  const gate = f.holdPrepare()
  let commits = 0
  const first = f.api.requestExit('install-update', () => { commits++ })
  const duplicate = f.api.requestExit('install-update', () => { commits++ })
  assert.equal(first, duplicate)
  await tick()
  assert.equal(commits, 0)
  gate.resolve()
  assert.equal((await first).status, 'committed')
  assert.equal(commits, 1)
  console.log('✓ 等待在途保存；重复点击只调用一次安装commit')
}
{
  const f = mainFixture()
  assert.equal((await f.api.requestExit('install-update', async () => { throw new Error('installer refused') })).status, 'failed')
  assert.equal(f.appState.quitting, false)
  assert.equal(f.api.isExitPreparing(), false)
  assert.equal(f.installCancelled, 1)
  f.failCancel(true)
  const failure = await f.api.requestExit('quit', () => assert.fail('cancel failure must not commit'))
  assert.equal(failure.status, 'failed')
  assert.match(failure.message, /cancel failed/)
  console.log('✓ 安装commit拒绝与撤销pending失败均保留应用并恢复准入')
}
{
  const f = mainFixture()
  f.setIgnore(true)
  const quit = f.api.requestExit('quit', () => assert.fail('timeout must not commit'))
  await tick()
  for (const fn of [...f.timers.values()]) fn()
  assert.equal((await quit).status, 'failed')
  assert.equal(f.appState.quitting, false)
  assert.throws(() => f.api.registerExitResponse({ sender: f.windows[0].webContents }, { requestId: 'old', stage: 'inspect', drafts: [] }))
  f.setIgnore(false)
  f.setCrash(true)
  assert.equal((await f.api.requestExit('quit', () => assert.fail('crash must not commit'))).status, 'failed')
  console.log('✓ 超时、崩溃与迟到回复不会提交退出')
}

function rendererFixture() {
  const exports = {}, responses = [], listeners = new Map()
  let handler
  vm.runInNewContext(rendererCode, { exports, console,
    document: { documentElement: { style: {}, setAttribute() {} } },
    window: { addEventListener(name, fn) { listeners.set(name, fn) } },
    require(id) {
      if (id === 'react') return { useEffect() {}, useRef: (value) => ({ current: value }) }
      if (id === './api') return { api: { on(_channel, callback) { handler = callback }, exitResponse: async (response) => { responses.push(response) } } }
      throw new Error(`Unexpected dependency ${id}`)
    }
  })
  exports.installRendererExitLifecycle()
  return { api: exports, responses, async request(stage, decisions) {
    const expected = responses.length + 1
    handler({ requestId: 'r', reason: 'install-update', stage, decisions })
    for (let attempt = 0; stage !== 'resume' && responses.length < expected && attempt < 100; attempt++) await tick()
    return responses.at(-1)
  } }
}
{
  const f = rendererFixture(), operations = []
  f.api.registerExitParticipant({ id: 'note', label: '笔记', isDirty: () => true, prepare: async (decision) => { operations.push(decision) } })
  assert.equal((await f.request('inspect')).drafts.length, 1)
  assert.equal(operations.length, 0)
  assert.equal(f.api.isExitPreparing(), true)
  await f.request('prepare', { note: 'save' })
  assert.deepEqual(operations, ['save'])
  await f.request('resume')
  assert.equal(f.api.isExitPreparing(), false)
  console.log('✓ renderer inspect只读取草稿，prepare才执行已收集的选择')
}
{
  const f = rendererFixture(), gate = deferred()
  void f.api.trackExitSave(gate.promise, 'settings')
  await f.request('inspect')
  const preparation = f.request('prepare')
  await tick()
  assert.equal(f.responses.length, 1)
  gate.resolve()
  assert.equal((await preparation).stage, 'prepare')
  await f.request('resume')
  await f.api.trackExitSave(Promise.reject(new Error('write failed')), 'settings').catch(() => {})
  await f.request('inspect')
  assert.match((await f.request('prepare')).error, /write failed/)
  await f.api.trackExitSave(Promise.resolve(), 'settings')
  assert.equal((await f.request('prepare')).error, undefined)
  console.log('✓ renderer等待在途保存，失败传播，成功重试清除同项错误')
}

{
  const exports = {}
  vm.runInNewContext(compile('../src/main/content-lifecycle.ts'), { exports })
  exports.setExitPreparing(true)
  await exports.trackContentWork(Promise.reject(new Error('capture save failed'))).catch(() => {})
  await assert.rejects(exports.flushContentWork(), /capture save failed/)
  await exports.flushContentWork()
  exports.setExitPreparing(false)
  console.log('✓ 退出期间提前结束的后台保存失败仍保留到flush，不会误放行')
}
