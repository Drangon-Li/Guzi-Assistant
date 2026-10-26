import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function load(name, mocks = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(code, {
    exports, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id) => { assert.ok(id in mocks, `unexpected dependency: ${id}`); return mocks[id] }
  })
  return exports
}

function fixture({ keepAudio = false, holdAudio = false, holdTranscript = false, holdParse = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guzi-voice-reset-'))
  const life = load('content-lifecycle')
  const audioStarted = deferred(), audioRelease = deferred(), transcribe = deferred(), parse = deferred()
  const state = { segments: [], sources: [], tasks: [], updates: [], transcribeCalls: 0, signal: null, seq: 0 }
  const db = {
    activeVoiceSession: () => null,
    addVoiceSegment: (segment) => state.segments.push(segment),
    createVoiceSession: () => ({ id: `session-${++state.seq}`, app: null, status: 'recording' }),
    getSettings: () => ({ voiceKeepAudio: keepAudio, voiceNotesEnabled: false }),
    getVoiceSession: () => null,
    sessionTranscript: () => state.segments.map((segment) => segment.text).join('\n'),
    updateVoiceSession: (id, patch) => state.updates.push({ id, patch }),
    createSource: (source) => { state.sources.push(source); return { id: 'source-1' } },
    deleteSourceRow() {},
    findDuplicateTitle: () => null,
    listWorkRecordsSince: () => []
  }
  const parseModule = load('voicenotes/parse', {
    '../db': db,
    '../capture': { excerptOf: (text) => text.slice(0, 80), HINTS: { voice_note: 'voice' } },
    '../parser': { parseToItems: () => holdParse ? parse.promise : Promise.resolve([]) },
    '../task-ingest': { createTaskFromItem: (...args) => state.tasks.push(args) },
    '@shared/sensitive': { redactSensitive: (text) => ({ text }) },
    '@shared/voicenotes': { recentWorkBlock: () => '' },
    '@shared/work-report': { dayKey: () => '2026-10-24' },
    '../content-lifecycle': life
  })
  const voice = load('voicenotes/service', {
    'fs/promises': {
      ...files,
      writeFile: async (...args) => {
        audioStarted.resolve()
        if (holdAudio) await audioRelease.promise
        return files.writeFile(...args)
      }
    },
    path: { join },
    electron: { app: { getPath: () => dir } },
    '../db': db,
    '../frontapp': {},
    '../privacy': {},
    '../windows': { broadcast() {}, debugEvent() {} },
    '@shared/parsing': { localNow: () => '2026-10-24T08:00' },
    '@shared/voicenotes': {},
    './transcribe': {
      pcmToWav: (buffer) => buffer,
      transcribeSegment: (_wav, signal) => {
        state.transcribeCalls++
        state.signal = signal
        return holdTranscript ? transcribe.promise : Promise.resolve({ text: 'private voice' })
      }
    },
    './parse': parseModule,
    '../content-lifecycle': life
  })
  const session = voice.startVoiceSession(null)
  const segment = { sessionId: session.id, pcmBase64: Buffer.from('pcm').toString('base64'), durationMs: 1000 }
  return {
    life, voice, state, dir, segment, audioStarted, audioRelease, transcribe, parse,
    clear: () => { state.segments = []; state.sources = []; state.tasks = []; state.updates = [] },
    close: () => { voice.stopVoiceWatch(); rmSync(dir, { recursive: true, force: true }) }
  }
}

{
  const f = fixture({ holdTranscript: true })
  try {
    const job = f.voice.ingestSegment(f.segment)
    assert.equal(f.state.transcribeCalls, 1)
    const release = f.life.beginContentReset()
    await f.voice.resetVoiceContent()
    assert.ok(f.state.signal.aborted)
    f.clear()
    release()
    f.voice.startVoiceSession(null)
    let newStopFinished = false
    const newStop = f.voice.stopVoiceSession().then(() => { newStopFinished = true })
    f.voice.acknowledgeVoiceCaptureStopped(f.voice.currentVoiceSession().id)
    await newStop
    assert.ok(newStopFinished, '新录制不应等待已取消的旧转录')
    f.clear()
    f.transcribe.resolve({ text: 'late private transcript' })
    await job
    assert.equal(f.voice.currentVoiceSession(), null)
    assert.equal(f.state.segments.length, 0)
    assert.equal(f.state.updates.length, 0)
    console.log('✓ 取消录制与转录；即使提供方忽略abort，清空后迟到转录也不再写库')
  } finally { f.close() }
}

{
  const f = fixture({ keepAudio: true, holdAudio: true })
  try {
    const job = f.voice.ingestSegment(f.segment)
    await f.audioStarted.promise
    const release = f.life.beginContentReset()
    let finished = false
    const reset = f.voice.resetVoiceContent().then(() => { finished = true })
    await Promise.resolve()
    assert.equal(finished, false)
    f.audioRelease.resolve()
    await reset
    await files.rm(join(f.dir, 'voice-notes'), { recursive: true, force: true })
    release()
    await job
    assert.equal(f.state.transcribeCalls, 0)
    assert.equal(existsSync(join(f.dir, 'voice-notes')), false)
    console.log('✓ 等待已开始的录音文件写入，再删临时目录，清空后不再创建文件或发起转录')
  } finally { f.close() }
}

{
  const f = fixture({ holdParse: true })
  try {
    await f.voice.ingestSegment(f.segment)
    const job = f.voice.stopVoiceSession()
    f.voice.acknowledgeVoiceCaptureStopped(f.voice.currentVoiceSession().id)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.state.sources.length, 1)
    const release = f.life.beginContentReset()
    await f.voice.resetVoiceContent()
    f.clear()
    release()
    f.parse.resolve([{ belongs_to_user: 'yes', title: 'late task', start_time: null, due_time: null }])
    await job
    assert.equal(f.state.tasks.length, 0)
    assert.equal(f.state.sources.length, 0)
    assert.equal(f.state.updates.length, 0)
    console.log('✓ 已经进入语音任务解析的迟到模型结果，也无法恢复来源、任务或会话状态')
  } finally { f.close() }
}

{
  const f = fixture()
  try {
    await f.voice.ingestSegment({ ...f.segment, seq: 0 })
    let stopped = false
    const finishing = f.voice.stopVoiceSession().then(() => { stopped = true })
    await Promise.resolve()
    assert.equal(stopped, false)
    assert.equal(f.voice.currentVoiceSession().status, 'finalizing')
    await f.voice.ingestSegment({ ...f.segment, seq: 1 })
    assert.equal(f.state.segments.length, 2, '停止ACK前仍接纳最后一段音频')
    await f.voice.ingestSegment({ ...f.segment, seq: 1 })
    assert.equal(f.state.segments.length, 2, '重试已成功的段不会重复落库')
    f.voice.acknowledgeVoiceCaptureStopped(f.segment.sessionId)
    await finishing
    assert.equal(f.voice.currentVoiceSession(), null)
    console.log('✓ 等待采集停止ACK并接纳最后音频段；同序号成功段重试不重复入库')
  } finally { f.close() }
}
