import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as pomodoro from '../src/shared/pomodoro.ts'

const source = ts.transpileModule(readFileSync(new URL('../src/renderer/src/plugins/pomodoro/Page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
}).outputText
const session = (kind, id) => ({
  id, kind, minutes: kind === 'focus' ? 25 : 5, startAt: new Date().toISOString(),
  endAt: null, completed: false, pausedAt: null, pausedMs: 0,
  blockId: null, taskId: null, taskTitle: null, note: null, review: null
})

function harness(initial) {
  const state = { running: initial.running, next: initial.next ?? null }
  const prefs = { ...pomodoro.DEFAULT_PREFS, autoStart: initial.autoStart ?? true }
  const calls = []
  const hooks = []
  const effects = []
  const listeners = new Set()
  let index = 0
  let tree
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i])
  const react = {
    useState(value) {
      const key = index++
      if (!(key in hooks)) hooks[key] = typeof value === 'function' ? value() : value
      return [hooks[key], (next) => { hooks[key] = typeof next === 'function' ? next(hooks[key]) : next }]
    },
    useRef(value) { return hooks[index++] ??= { current: value } },
    useMemo(fn, deps) {
      const key = index++
      if (!same(hooks[key]?.deps, deps)) hooks[key] = { value: fn(), deps }
      return hooks[key].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const key = index++
      if (!same(hooks[key]?.deps, deps)) effects.push(() => {
        hooks[key]?.cleanup?.()
        hooks[key] = { deps, cleanup: fn() }
      })
    }
  }
  const emit = (event, id) => listeners.forEach((fn) => fn({ event, payload: { sessionId: id } }))
  const api = {
    listTasks: async () => [],
    on: (_event, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    async plugin(_plugin, action, ...args) {
      calls.push(action)
      if (action === 'prefs') return prefs
      if (action === 'history') return []
      if (action === 'running') return structuredClone(state.running)
      if (action === 'runtime') return structuredClone(state)
      if (action === 'today') return {
        sessions: [], byTask: [], stats: pomodoro.dayStats([], '2026-10-24', pomodoro.DEFAULT_GOAL)
      }
      if (action === 'finish') {
        const old = state.running
        state.running = prefs.autoStart ? session('focus', 'next-focus') : null
        state.next = prefs.autoStart ? null : pomodoro.nextPhase('break', 0, prefs)
        emit('pomodoro:break-completed', old.id)
        return true
      }
      if (action === 'dismiss-next') { state.next = null; return true }
      if (action === 'start') { state.running = session(args[0], 'unexpected-renderer-start'); state.next = null; return state.running }
      if (action === 'say') return true
      throw new Error(`Unexpected action: ${action}`)
    }
  }
  const exports = {}
  const jsx = (type, props) => ({ type, props })
  vm.runInNewContext(source, {
    exports,
    require(id) {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (id === '@shared/pomodoro') return pomodoro
      if (id === '@shared/task-filters') return { isFinishedEvent: () => false }
      if (id === '@shared/timeblock') return { minutesToLabel: String }
      if (id === '@shared/work-report') return { dayKey: () => '2026-10-24' }
      if (id === '../../api') return { api }
      if (id === '../../components/ui') return { Section: 'Section', Segmented: 'Segmented' }
      return { __esModule: true, default: id }
    },
    window: { setInterval: () => 1, clearInterval() {} }
  })
  const render = () => {
    index = 0
    tree = exports.default({ enabledPlugins: [] })
    while (effects.length) effects.shift()()
  }
  const nodes = (node) => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
  const text = (node) => node == null ? '' : typeof node !== 'object' ? String(node)
    : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children)
  const settle = async () => { await new Promise(setImmediate); render() }
  render()
  return {
    calls, state, settle, emit, text: () => text(tree),
    async click(label) {
      const button = nodes(tree).find((node) => node.type === 'button' && text(node) === label)
      assert.ok(button, `Missing button ${label}`)
      button.props.onClick()
      await settle()
    },
    close: () => hooks.forEach((hook) => hook?.cleanup?.())
  }
}

async function test(name, run) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { process.exitCode = 1; console.error(`✗ ${name}: ${error.stack}`) }
}

await test('到点事件后显示主进程真实下一阶段，不由页面重复start', async () => {
  const h = harness({ running: session('focus', 'first') })
  await h.settle()
  h.state.running = session('break', 'next-break')
  h.emit('pomodoro:round-completed', 'first')
  await h.settle()
  assert.ok(h.text().includes('休息中'))
  assert.equal(h.calls.filter((action) => action === 'start').length, 0)
  h.close()
})

await test('跳过休息只finish一次，页面读取已衔接专注而不重复启动/播报', async () => {
  const h = harness({ running: session('break', 'rest') })
  await h.settle()
  await h.click('跳过休息')
  assert.ok(h.text().includes('专注中'))
  assert.equal(h.calls.filter((action) => action === 'finish').length, 1)
  assert.equal(h.calls.filter((action) => action === 'start').length, 0)
  assert.equal(h.calls.filter((action) => action === 'say').length, 0)
  h.close()
})

await test('重新打开页面读取待确认阶段，偏好开关不会成为第二推进源', async () => {
  const h = harness({ running: null, next: { kind: 'break', minutes: 5, long: false }, autoStart: true })
  await h.settle()
  await h.settle()
  assert.ok(h.text().includes('该休息了'))
  assert.equal(h.calls.filter((action) => action === 'start').length, 0)
  await h.click('先停一下')
  assert.equal(h.calls.filter((action) => action === 'dismiss-next').length, 1)
  assert.ok(h.text().includes('准备开始'))
  h.close()
})
