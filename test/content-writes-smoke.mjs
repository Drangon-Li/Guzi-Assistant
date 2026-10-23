import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(name, mocks = {}) {
  const source = readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports, console, Buffer, process,
    require: (id) => {
      if (id === 'path' || id === 'crypto') return require(id)
      assert.ok(id in mocks, `Unexpected ${name} dependency: ${id}`)
      return mocks[id]
    }
  })
  return exports
}
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const lifecycle = load('content-lifecycle')
  const model = deferred()
  const extraction = deferred()
  const writes = []
  const reads = []
  let requests = 0
  const db = {
    getProfile: () => ({ name: 'Test', confirmMode: 'standard' }),
    listTasks: () => [{ title: 'Task', belongsToUser: 'yes', status: 'not_started', tags: [] }],
    listWorkRecords: () => [{ content: 'Report evidence' }],
    listWorkRecordsSince: () => [], appUsageSummary: () => [],
    getPersonalMemory: () => ({ base: '', recent: '' }), personalMemoryText: () => '',
    addReport: (value) => { writes.push(['report', value]); return value },
    setPersonalMemory: (...args) => { writes.push(['memory', ...args]); return {} },
    createSource: () => { writes.push(['source']); return { id: 'source' } },
    deleteSourceRow: () => writes.push(['delete-source']),
    findDuplicateTitle: () => null,
    getTask: () => null, updateTask: () => writes.push(['update-task'])
  }
  const parser = { callModel: () => { requests++; return model.promise }, parseToItems: () => { requests++; return model.promise } }
  const sharedReport = {
    buildDailyReportPrompt: () => ({ instructions: '', text: '' }),
    defaultReportTitle: () => 'Report', splitTasksForDay: () => ({ done: [], open: [] }),
    buildPersonalMemoryPrompt: () => ({ instructions: '', text: '' }),
    buildBaseMemoryPrompt: () => ({ instructions: '', text: '' }),
    dayKey: () => '2026-10-24', groupWorkPeriods: () => [], periodLabel: () => '', workRecordStart: () => ''
  }
  const common = {
    './content-lifecycle.ts': lifecycle, './db': db, './parser': parser,
    './task-ingest': { createTaskFromItem: () => { writes.push(['task']); return { id: 'task' } }, scheduledStatus: () => 'scheduled' },
    './windows': { broadcast() {}, showPreview() {} },
    './pet/controller': { applyExternalPetReaction() {}, applyExternalPetSay() {} }
  }
  return {
    lifecycle, model, extraction, writes, reads, requests: () => requests,
    report: load('report', { ...common, '@shared/work-report': sharedReport }),
    memory: load('personal-memory', { ...common, '@shared/work-report': sharedReport }),
    assistant: load('assistant', {
      ...common,
      './detection-cards': { buildDetectionCards() {}, parsedToExtraction() {}, showDetectedCards() {} },
      './plugins/index.ts': { assistantActions: () => '', assistantContext: () => '', runAssistantAction() {} },
      '@shared/parsing': {
        buildAssistantInstructions: () => '',
        parseAssistantOutput: () => ({ reply: '', add: [1], candidates: [], ops: [], actions: [] }),
        resolveAddPicks: () => [{ item: { title: 'Task' }, candidate: 1, force: true, source: 'current' }]
      }
    }),
    capture: load('capture', {
      ...common, electron: { app: {}, clipboard: {}, nativeImage: {} }, child_process: {},
      fs: { existsSync: () => true, readFileSync: (file) => { reads.push(file); return 'test file' }, unlinkSync() {} },
      './frontapp': {}, './privacy': {}, './activity-tracker': {}, './screen-snapshot.ts': {},
      'pdf-parse': () => extraction.promise, mammoth: {},
      '@shared/sensitive': { redactSensitive: (text) => ({ text }), detectSensitive: () => [] }
    })
  }
}

function reset(f) { const release = f.lifecycle.beginContentReset(); f.writes.length = 0; release() }
async function test(name, run) {
  try { await run(); console.log(`✓ ${name}`) }
  catch (error) { console.error(`✗ ${name}: ${error.stack}`); process.exitCode = 1 }
}

await test('清空后的迟到日报与两种画像不能写回', async () => {
  const f = fixture()
  const outcomes = Promise.allSettled([
    f.report.generateDailyReport('2026-10-24'), f.memory.refreshPersonalMemory(), f.memory.refreshBaseMemory()
  ])
  reset(f)
  f.model.resolve('old response')
  assert.ok((await outcomes).every((result) => result.status === 'rejected'))
  assert.equal(f.writes.length, 0)
})

await test('清空后的聊天结果不会执行添加任务或插件动作', async () => {
  const f = fixture()
  const result = f.assistant.assistantChat({ history: [{ role: 'user', content: 'old request' }], candidates: null })
  reset(f)
  f.model.resolve('old response')
  assert.ok((await result).error)
  assert.equal(f.writes.length, 0)
})

await test('解析期间清空不写回任务，不从同批次启动下一文件', async () => {
  const f = fixture()
  const result = f.capture.submitFiles(['one.txt', 'two.txt'])
  await new Promise(setImmediate)
  assert.equal(f.requests(), 1)
  reset(f)
  f.model.resolve([{ title: 'Old task', belongs_to_user: 'yes' }])
  assert.ok((await result)[0].error)
  assert.equal(f.writes.length, 0)
  assert.equal(f.requests(), 1)
  assert.deepEqual(f.reads, ['one.txt'])
})

await test('文件抽取期间清空，不建立来源或发起后续模型请求', async () => {
  const f = fixture()
  const result = f.capture.submitFiles(['one.pdf', 'two.txt'])
  reset(f)
  f.extraction.resolve({ text: 'old extracted text' })
  await result
  assert.equal(f.writes.length, 0)
  assert.equal(f.requests(), 0)
  assert.deepEqual(f.reads, ['one.pdf'])
})

await test('清空期间拒绝新操作，清空结束后的新操作仍可保存', async () => {
  const f = fixture()
  const release = f.lifecycle.beginContentReset()
  await assert.rejects(f.report.generateDailyReport('2026-10-24'))
  await assert.rejects(f.capture.submitFiles(['one.txt']))
  assert.equal(f.requests(), 0)
  release()
  const report = f.report.generateDailyReport('2026-10-24')
  f.model.resolve('new report')
  await report
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0][0], 'report')
})
