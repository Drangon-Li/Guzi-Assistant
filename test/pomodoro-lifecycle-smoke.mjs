import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const compiled = new Map()

function load(name, mocks, clock) {
  if (!compiled.has(name)) {
    compiled.set(name, ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText)
  }
  const exports = {}
  vm.runInNewContext(compiled.get(name), {
    exports,
    require: (id) => {
      if (id === 'crypto') return require(id)
      assert.ok(id in mocks, `unexpected dependency: ${id}`)
      return mocks[id]
    },
    console,
    ...clock
  }, { filename: `${name}.ts` })
  return exports
}

function fixture() {
  let now = new Date(2026, 9, 24, 8, 0, 0).getTime()
  let timerId = 0
  const timers = new Map()
  const events = []
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const tasks = new Map()
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const clock = {
    Date: Clock,
    setTimeout: (fn, ms) => {
      const id = ++timerId
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout: (id) => timers.delete(id)
  }
  const plugin = load('main/plugins/pomodoro/index', {
    '../../db/connection.ts': { getDb: () => db },
    '../../db/plugins.ts': {
      readPluginSetting: (plugin, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(`plugin:${plugin}:${key}`)?.value ?? null,
      writePluginSetting: (plugin, key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`plugin:${plugin}:${key}`, value)
    },
    '../../pet/controller': { applyExternalPetReaction() {}, applyExternalPetSay() {} },
    '../index.ts': { emitPluginEvent: (from, name, payload) => events.push({ from, name, payload }) },
    '../../db': { getTask: (id) => tasks.get(id) ?? null },
    '../../parser': {},
    '@shared/parsing': load('shared/parsing', {}, clock),
    '@shared/work-report': load('shared/work-report', {}, clock),
    '@shared/pomodoro': load('shared/pomodoro', {}, clock),
    '@shared/pomodoro-review': {}
  }, clock).default
  plugin.initTables(db)
  return {
    db, plugin, events, timers, tasks,
    now: () => now,
    advance: (ms) => { now += ms },
    fire: () => {
      const due = [...timers].filter(([, timer]) => timer.at <= now)
      assert.ok(due.length, 'expected a due round timer')
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.fn()
      }
    },
    close: () => { plugin.dispose(); db.close() }
  }
}

let failures = 0
function check(name, test) {
  const f = fixture()
  try {
    test(f)
    console.log(`✓ ${name}`)
  } catch (error) {
    failures++
    console.error(`✗ ${name}: ${error.message}`)
  } finally {
    f.close()
  }
}

check('重复开始复用当前会话，只有一个会话和一个定时器', (f) => {
  const first = f.plugin.handlers.start('focus', 25, 'block-1')
  const second = f.plugin.handlers.start('focus', 10, 'block-2')
  assert.equal(second.id, first.id)
  assert.equal(second.minutes, 25)
  assert.equal(second.blockId, 'block-1')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p_pomodoro_session').get().n, 1)
  assert.equal(f.timers.size, 1)
  f.advance(25 * 60_000 + 250)
  f.fire()
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p_pomodoro_session WHERE end_at IS NULL').get().n, 0)
  assert.equal(f.events.length, 1)
})

check('暂停中重复开始保留暂停，不建立新的会话或定时器', (f) => {
  const first = f.plugin.handlers.start('focus', 25)
  f.plugin.handlers.pause(first.id)
  const second = f.plugin.handlers.start('break', 5)
  assert.equal(second.id, first.id)
  assert.ok(second.pausedAt)
  assert.equal(f.timers.size, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p_pomodoro_session').get().n, 1)
})

check('重启恢复已过期轮次，结束时间与实际分钟停在计划截止', (f) => {
  const session = f.plugin.handlers.start('focus', 25, 'block-1')
  const deadline = f.now() + 25 * 60_000
  f.advance(120 * 60_000)
  f.plugin.dispose()
  f.plugin.init()
  f.advance(250)
  f.fire()
  const ended = f.db.prepare('SELECT * FROM p_pomodoro_session WHERE id = ?').get(session.id)
  assert.equal(Date.parse(ended.end_at), deadline)
  assert.equal(ended.completed, 1)
  assert.equal(f.events[0].payload.actualMinutes, 25)
})

check('延迟到点按累计暂停延后截止，不计入额外离线时间', (f) => {
  const session = f.plugin.handlers.start('focus', 25)
  const start = f.now()
  f.advance(10 * 60_000)
  f.plugin.handlers.pause(session.id)
  f.advance(5 * 60_000)
  f.plugin.handlers.resume(session.id)
  f.advance(60 * 60_000)
  f.fire()
  const ended = f.db.prepare('SELECT * FROM p_pomodoro_session WHERE id = ?').get(session.id)
  assert.equal(Date.parse(ended.end_at), start + 30 * 60_000)
  assert.equal(ended.paused_ms, 5 * 60_000)
  assert.equal(f.events[0].payload.actualMinutes, 25)
})

check('手动提前结束仍记录当前时间，并结算当前暂停', (f) => {
  const session = f.plugin.handlers.start('focus', 25)
  f.advance(8 * 60_000)
  f.plugin.handlers.pause(session.id)
  f.advance(2 * 60_000)
  f.plugin.handlers.finish(session.id, false)
  const ended = f.db.prepare('SELECT * FROM p_pomodoro_session WHERE id = ?').get(session.id)
  assert.equal(Date.parse(ended.end_at), f.now())
  assert.equal(ended.paused_ms, 2 * 60_000)
  assert.equal(ended.completed, 0)
  assert.equal(f.events.length, 0)
  assert.equal(f.timers.size, 0)
})

check('主进程无页面时自动接短休息，再接下一轮专注', (f) => {
  f.plugin.handlers['prefs-save']({ autoStart: true })
  f.plugin.handlers.start('focus', 25)
  f.advance(25 * 60_000 + 250)
  f.fire()
  let current = f.plugin.handlers.running()
  assert.equal(current.kind, 'break')
  assert.equal(current.minutes, 5)
  assert.equal(current.blockId, null)
  assert.equal(current.taskId, null)
  assert.equal(Date.parse(current.startAt), Math.floor(f.now() / 1000) * 1000)
  assert.equal(f.timers.size, 1)
  f.advance(5 * 60_000 + 250)
  f.fire()
  current = f.plugin.handlers.running()
  assert.equal(current.kind, 'focus')
  assert.equal(current.minutes, 25)
  assert.equal(f.events.length, 2)
  assert.equal(f.timers.size, 1)
})

check('达到轮数时自动接长休息，采用最新设置', (f) => {
  const first = f.plugin.handlers.start('focus', 1)
  f.advance(60_000)
  f.plugin.handlers.finish(first.id, true)
  f.plugin.handlers.start('focus', 1)
  f.plugin.handlers['prefs-save']({ autoStart: true, roundsBeforeLongBreak: 2, longBreakMin: 12 })
  f.advance(60_000 + 250)
  f.fire()
  const current = f.plugin.handlers.running()
  assert.equal(current.kind, 'break')
  assert.equal(current.minutes, 12)
})

check('关闭自动开始只留下下一阶段提示，可手动忽略', (f) => {
  f.plugin.handlers.start('focus', 1)
  f.advance(60_000 + 250)
  f.fire()
  let runtime = f.plugin.handlers.runtime()
  assert.equal(runtime.running, null)
  assert.equal(runtime.next.kind, 'break')
  assert.equal(runtime.next.minutes, 5)
  assert.equal(f.timers.size, 0)
  f.plugin.handlers['dismiss-next']()
  runtime = f.plugin.handlers.runtime()
  assert.equal(runtime.next, null)
})

check('重启恢复只结算过期的一轮，下一阶段从现在开始', (f) => {
  f.plugin.handlers['prefs-save']({ autoStart: true })
  f.plugin.handlers.start('focus', 25)
  f.advance(12 * 60 * 60_000)
  f.plugin.dispose()
  f.plugin.init()
  f.advance(250)
  f.fire()
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p_pomodoro_session').get().n, 2)
  assert.equal(f.events.length, 1)
  const current = f.plugin.handlers.running()
  assert.equal(current.kind, 'break')
  assert.equal(Date.parse(current.startAt), Math.floor(f.now() / 1000) * 1000)
  assert.equal(f.timers.size, 1)
})

check('跳过休息由主进程衔接，重复finish不重复结算或清掉新轮定时器', (f) => {
  f.plugin.handlers['prefs-save']({ autoStart: true })
  const rest = f.plugin.handlers.start('break', 5)
  f.advance(60_000)
  f.plugin.handlers.finish(rest.id, true)
  const next = f.plugin.handlers.running()
  assert.equal(next.kind, 'focus')
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].name, 'break-completed')
  f.plugin.handlers.finish(rest.id, true)
  f.plugin.handlers.finish(rest.id, false)
  assert.equal(f.plugin.handlers.running().id, next.id)
  assert.equal(f.timers.size, 1)
  assert.equal(f.events.length, 1)
  assert.equal(f.db.prepare('SELECT completed FROM p_pomodoro_session WHERE id = ?').get(rest.id).completed, 1)
})

check('放弃专注即停止，即使自动开始开启也不续开', (f) => {
  f.plugin.handlers['prefs-save']({ autoStart: true })
  const current = f.plugin.handlers.start('focus', 25)
  f.advance(60_000)
  f.plugin.handlers.finish(current.id, false)
  const runtime = f.plugin.handlers.runtime()
  assert.equal(runtime.running, null)
  assert.equal(runtime.next, null)
  assert.equal(f.timers.size, 0)
  assert.equal(f.events.length, 0)
})

check('dispose清除待确认提示，清空数据后init不能复活下一轮', (f) => {
  f.plugin.handlers.start('focus', 1)
  f.advance(60_000 + 250)
  f.fire()
  assert.ok(f.plugin.handlers.runtime().next)
  f.plugin.dispose()
  f.db.prepare('DELETE FROM p_pomodoro_session').run()
  f.plugin.init()
  assert.equal(f.plugin.handlers.runtime().next, null)
  assert.equal(f.plugin.handlers.runtime().running, null)
  assert.equal(f.timers.size, 0)
})

check('休息不带关联，重启后自动专注恢复上一轮任务与作息块', (f) => {
  f.db.exec('CREATE TABLE p_timeblock_block (id TEXT PRIMARY KEY)')
  f.db.prepare('INSERT INTO p_timeblock_block (id) VALUES (?)').run('block-1')
  f.tasks.set('task-1', { id: 'task-1' })
  f.plugin.handlers['prefs-save']({ autoStart: true })
  f.plugin.handlers.start('focus', 1, 'block-1', 'task-1', '报告')
  f.advance(60_000 + 250)
  f.fire()
  const rest = f.plugin.handlers.running()
  assert.equal(rest.blockId, null)
  assert.equal(rest.taskId, null)
  assert.equal(rest.taskTitle, null)
  const context = JSON.parse(f.db.prepare('SELECT value FROM settings WHERE key = ?').get('plugin:pomodoro:continuation').value)
  assert.equal(context.breakSessionId, rest.id)
  assert.equal(context.taskId, 'task-1')
  f.plugin.dispose()
  f.plugin.init()
  f.advance(5 * 60_000 + 250)
  f.fire()
  const current = f.plugin.handlers.running()
  assert.equal(current.kind, 'focus')
  assert.equal(current.taskId, 'task-1')
  assert.equal(current.taskTitle, '报告')
  assert.equal(current.blockId, 'block-1')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM settings WHERE key = ?').get('plugin:pomodoro:continuation').n, 0)
})

check('休息中删除的任务和作息块不会在自动续接时复活', (f) => {
  f.db.exec('CREATE TABLE p_timeblock_block (id TEXT PRIMARY KEY)')
  f.db.prepare('INSERT INTO p_timeblock_block (id) VALUES (?)').run('block-1')
  f.tasks.set('task-1', { id: 'task-1' })
  f.plugin.handlers['prefs-save']({ autoStart: true })
  f.plugin.handlers.start('focus', 1, 'block-1', 'task-1', '报告')
  f.advance(60_000 + 250)
  f.fire()
  f.tasks.delete('task-1')
  f.db.prepare('DELETE FROM p_timeblock_block').run()
  f.advance(5 * 60_000 + 250)
  f.fire()
  const current = f.plugin.handlers.running()
  assert.equal(current.kind, 'focus')
  assert.equal(current.taskId, null)
  assert.equal(current.taskTitle, null)
  assert.equal(current.blockId, null)
  assert.equal(f.tasks.size, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM p_timeblock_block').get().n, 0)
})

check('续接上下文严格绑定休息会话，不错误关联其他历史任务', (f) => {
  f.plugin.handlers['prefs-save']({ autoStart: true })
  f.plugin.handlers.start('break', 1)
  f.tasks.set('old-task', { id: 'old-task' })
  f.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('plugin:pomodoro:continuation', JSON.stringify({
    breakSessionId: 'other-break', taskId: 'old-task', taskTitle: '旧任务', blockId: null
  }))
  f.advance(60_000 + 250)
  f.fire()
  assert.equal(f.plugin.handlers.running().taskId, null)
  assert.equal(f.plugin.handlers.running().taskTitle, null)
})

check('助手开始和中止使用相同运行状态，不复用旧阶段提示', (f) => {
  f.plugin.handlers.start('focus', 1)
  f.advance(60_000 + 250)
  f.fire()
  assert.ok(f.plugin.handlers.runtime().next)
  f.plugin.assistantActions['start-focus']({ minutes: 5, task: '写报告' })
  assert.equal(f.plugin.handlers.runtime().next, null)
  assert.equal(f.plugin.handlers.running().taskTitle, '写报告')
  f.plugin.handlers['prefs-save']({ autoStart: true })
  f.plugin.assistantActions['stop-focus']({})
  assert.equal(f.plugin.handlers.runtime().running, null)
  assert.equal(f.plugin.handlers.runtime().next, null)
  assert.equal(f.timers.size, 0)
})

process.exitCode = failures ? 1 : 0
