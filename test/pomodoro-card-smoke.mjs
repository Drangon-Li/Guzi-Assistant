import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as pomodoro from '../src/shared/pomodoro.ts'

const source = ts.transpileModule(readFileSync(new URL('../src/renderer/src/plugins/pomodoro/TodayCard.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText
const session = (kind, taskTitle = null) => ({
  id: kind, kind, taskTitle, minutes: 1, startAt: new Date().toISOString(),
  endAt: null, completed: false, pausedAt: null, pausedMs: 0
})
const stats = (rounds) => ({
  rounds, focusMinutes: rounds, abandoned: 0, goal: pomodoro.DEFAULT_GOAL,
  goalCurrent: rounds, remainingToGoal: 8 - rounds, goalProgress: rounds / 8
})

function harness(holdInitial = false) {
  const state = { running: session('focus'), stats: stats(0) }
  const hooks = [], effects = [], calls = [], listeners = new Set(), timers = new Map()
  let index = 0, timerId = 0, tree, closed = false, lateWrites = 0, releaseInitial
  const initial = new Promise((resolve) => { releaseInitial = resolve })
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i])
  const react = {
    useState(value) {
      const key = index++
      if (!(key in hooks)) hooks[key] = value
      return [hooks[key], (next) => {
        if (closed) lateWrites++
        hooks[key] = typeof next === 'function' ? next(hooks[key]) : next
      }]
    },
    useEffect(fn, deps) {
      const key = index++
      if (!same(hooks[key]?.deps, deps)) effects.push(() => {
        hooks[key]?.cleanup?.()
        hooks[key] = { deps, cleanup: fn() }
      })
    }
  }
  const api = {
    on(channel, listener) {
      assert.equal(channel, 'guzi-assistant:plugin-event')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async plugin(_plugin, action) {
      calls.push(action)
      const value = action === 'today' ? { stats: structuredClone(state.stats) }
        : action === 'running' ? structuredClone(state.running) : pomodoro.DEFAULT_PREFS
      if (holdInitial && calls.filter((call) => call === action).length === 1) await initial
      return value
    }
  }
  const exports = {}
  const jsx = (type, props) => ({ type, props })
  vm.runInNewContext(source, {
    exports,
    require(id) {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (id === '@shared/pomodoro') return pomodoro
      if (id === '../../api') return { api }
      throw new Error(`Unexpected dependency ${id}`)
    },
    window: {
      setInterval(fn) { timers.set(++timerId, fn); return timerId },
      clearInterval(id) { timers.delete(id) }
    }
  })
  const render = () => {
    index = 0
    tree = exports.default()
    while (effects.length) effects.shift()()
  }
  const text = (node) => node == null ? '' : typeof node !== 'object' ? String(node)
    : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children)
  const settle = async () => {
    await new Promise(setImmediate)
    render()
    await new Promise(setImmediate)
    render()
  }
  render()
  return {
    state, calls, settle, releaseInitial,
    emit: (event) => listeners.forEach((listener) => listener({ event })),
    text: () => text(tree), lateWrites: () => lateWrites,
    close() { closed = true; hooks.forEach((hook) => hook?.cleanup?.()) },
    listeners, timers
  }
}

async function test(name, run) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { process.exitCode = 1; console.error(`✗ ${name}: ${error.message}`) }
}

await test('专注完成后卡片显示新休息与完成轮数，休息完成后显示新专注', async () => {
  const h = harness()
  await h.settle()
  h.state.running = session('break')
  h.state.stats = stats(1)
  h.emit('pomodoro:round-completed')
  await h.settle()
  assert.ok(h.text().includes('休息中'), h.text())
  assert.ok(h.text().includes('1/8'), h.text())
  h.state.running = session('focus', '关联任务')
  h.emit('pomodoro:break-completed')
  await h.settle()
  assert.ok(h.text().includes('专注中 · 关联任务'), h.text())
  assert.equal(h.calls.filter((action) => action === 'running').length, 3)
  h.close()
})
await test('自动开始关闭时显示最新轮数和剩余目标，忽略无关插件事件', async () => {
  const h = harness()
  await h.settle()
  const before = h.calls.length
  h.emit('habit:checked')
  await h.settle()
  assert.equal(h.calls.length, before)
  h.state.running = null
  h.state.stats = stats(1)
  h.emit('pomodoro:round-completed')
  await h.settle()
  assert.ok(h.text().includes('1/8'), h.text())
  assert.ok(h.text().includes('还差 7 轮'), h.text())
  assert.ok(!h.text().includes('专注中'), h.text())
  h.close()
})
await test('迟到的初始读取不会覆盖完成事件后的新阶段', async () => {
  const h = harness(true)
  h.state.running = session('break')
  h.state.stats = stats(1)
  h.emit('pomodoro:round-completed')
  await h.settle()
  assert.ok(h.text().includes('休息中'), h.text())
  h.releaseInitial()
  await h.settle()
  assert.ok(h.text().includes('休息中'), h.text())
  assert.ok(h.text().includes('1/8'), h.text())
  h.close()
})
await test('卸载后清理订阅和计时器，迟到响应不再更新卡片', async () => {
  const h = harness(true)
  h.close()
  h.releaseInitial()
  await new Promise(setImmediate)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.lateWrites(), 0)
})
