import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(name, mocks = {}) {
  const exports = {}
  const source = readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(code, {
    exports,
    require: (id) => { assert.ok(id in mocks, `unexpected dependency ${id}`); return mocks[id] }
  })
  return exports
}

function fixture({ failFiles = false, failResume = [], failReload = false } = {}) {
  const lifecycle = load('content-lifecycle')
  const calls = []
  const errors = []
  const fileFailure = new Error('fixture file failure')
  const record = (name) => () => {
    calls.push(name)
    if (failResume.includes(name)) throw new Error(`fixture ${name} failure`)
  }
  let finishAudioWrite
  const audioWrite = new Promise((resolve) => { finishAudioWrite = resolve })
  const reset = load('data-reset', {
    electron: {
      dialog: { showErrorBox: (title, message) => { errors.push({ title, message }); calls.push('error-box') } },
      app: { getPath: (name) => { assert.equal(name, 'userData'); return '/fixture-only' } },
      BrowserWindow: { getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: { reload: () => {
          assert.equal(lifecycle.isContentResetting(), false)
          calls.push('reload')
          if (failReload) throw new Error('fixture reload failure')
        } }
      }, ...(failReload ? [{ isDestroyed: () => false, webContents: { reload: record('reload-second') } }] : [])] }
    },
    './content-lifecycle': lifecycle,
    './content-files': { clearUserContentFiles: async (dir) => {
      assert.equal(dir, '/fixture-only')
      assert.ok(lifecycle.isContentResetting())
      calls.push('files')
      if (failFiles) throw fileFailure
    } },
    './db/maintenance': { wipeAll: () => { assert.ok(lifecycle.isContentResetting()); calls.push('database') } },
    './history/service': {
      acquireHistoryMutationBarrier: () => { calls.push('history-barrier'); return record('history-release') },
      clearHistory: async () => { calls.push('history-clear') },
      stopHistoryPersistence: async () => { calls.push('history-stop') }
    },
    './screenwatch': { stopWatch: record('screen-stop'), applyScreenSenseSettings: record('screen-start') },
    './clipwatch': { stopClipWatch: record('clip-stop'), applyClipWatchSettings: record('clip-start') },
    './voicenotes/service': {
      resetVoiceContent: () => { calls.push('voice-stop'); return audioWrite },
      applyVoiceSettings: record('voice-start')
    },
    './plugins/index': { suspendPluginRuntime: record('plugins-stop'), resumePluginRuntime: record('plugins-start') },
    './task-reminder': { stopTaskReminder: record('reminder-stop'), applyTaskReminderSchedule: record('reminder-start') },
    './report-scheduler': { stopReportSchedule: record('report-stop') },
    './dropbox': { stopDropbox: record('dropbox-stop'), initDropbox: record('dropbox-start') },
    './mcp-server': { stopMcpServer: record('mcp-stop'), applyMcpSettings: record('mcp-start') },
    './hotkey': { unregisterScanHotkey: record('hotkey-stop') },
    './capture': { clearPendings: record('pending-clear') },
    './windows': { hidePreview: record('preview-hide') },
    './reminder-window': { hideReminderWindow: record('reminder-hide') },
    './quickbar': { hideQuickBar: record('quickbar-hide') },
    './pet/pet-chat-window': { hidePetChat: record('chat-hide') },
    './pet/controller': { resetPetContent: record('pet-clear') }
  })
  return { lifecycle, calls, errors, fileFailure, finishAudioWrite, reset: reset.resetAllUserContent }
}

{
  const f = fixture()
  const old = f.lifecycle.captureContentEpoch()
  const job = f.reset()
  assert.ok(f.lifecycle.isContentResetting())
  assert.equal(f.lifecycle.isContentEpochCurrent(old), false)
  assert.throws(() => f.lifecycle.captureContentEpoch(), /正在清除/)
  assert.equal(f.calls.includes('database'), false)
  await assert.rejects(f.reset(), /正在清除/)
  f.finishAudioWrite()
  await job
  const index = (name) => f.calls.indexOf(name)
  for (const stopped of ['screen-stop', 'clip-stop', 'voice-stop', 'plugins-stop', 'report-stop', 'mcp-stop', 'pending-clear']) {
    assert.ok(index(stopped) < index('database'), stopped)
  }
  assert.ok(index('history-clear') < index('database'))
  assert.ok(f.calls.lastIndexOf('history-stop') < index('files'))
  assert.ok(index('database') < index('files'))
  assert.ok(index('files') < index('history-release'))
  for (const resumed of ['reload', 'screen-start', 'clip-start', 'voice-start', 'plugins-start', 'reminder-start', 'dropbox-start', 'mcp-start']) {
    assert.ok(index('history-release') < index(resumed), resumed)
  }
  assert.equal(f.lifecycle.isContentEpochCurrent(old), false)
  assert.ok(f.lifecycle.isContentEpochCurrent(f.lifecycle.captureContentEpoch()))
  assert.equal(f.errors.length, 0)
  console.log('✓ 清空先失效并暂停入口，等待音频与历史写完后清表/删文件；释放后重载并恢复服务')
}

{
  const f = fixture({ failFiles: true })
  const old = f.lifecycle.captureContentEpoch()
  const job = f.reset()
  f.finishAudioWrite()
  await assert.rejects(job, /fixture file failure/)
  assert.equal(f.lifecycle.isContentResetting(), false)
  assert.equal(f.lifecycle.isContentEpochCurrent(old), false)
  assert.ok(f.calls.includes('reload'))
  assert.ok(f.calls.includes('mcp-start'))
  assert.equal(f.errors.length, 1)
  assert.equal(f.errors[0].title, '清除未完成')
  assert.match(f.errors[0].message, /fixture file failure/)
  assert.ok(f.calls.indexOf('error-box') > f.calls.indexOf('mcp-start'))
  console.log('✓ 文件失败向调用方报告，释放屏障恢复界面，旧请求仍永久失效')
}

{
  const f = fixture({ failFiles: true, failResume: ['plugins-start', 'dropbox-start'] })
  const job = f.reset()
  f.finishAudioWrite()
  await assert.rejects(job, (error) => error === f.fileFailure)
  assert.equal(f.lifecycle.isContentResetting(), false)
  for (const stage of ['reload', 'plugins-start', 'screen-start', 'clip-start', 'voice-start', 'reminder-start', 'dropbox-start', 'mcp-start']) {
    assert.ok(f.calls.includes(stage), stage)
  }
  assert.equal(f.errors.length, 1)
  assert.match(f.errors[0].message, /fixture file failure/)
  assert.match(f.errors[0].message, /fixture plugins-start failure/)
  assert.match(f.errors[0].message, /fixture dropbox-start failure/)
  assert.ok(f.calls.indexOf('error-box') > f.calls.indexOf('mcp-start'))
  console.log('✓ 恢复途中多处失败仍尝试所有后续服务；合并提示且不覆盖原清理错误')
}

{
  const f = fixture({ failReload: true, failResume: ['dropbox-start'] })
  const job = f.reset()
  f.finishAudioWrite()
  await assert.rejects(job, /fixture reload failure/)
  assert.equal(f.lifecycle.isContentResetting(), false)
  assert.ok(f.calls.includes('reload-second'))
  assert.ok(f.calls.includes('mcp-start'))
  assert.equal(f.errors.length, 1)
  assert.match(f.errors[0].message, /fixture reload failure/)
  assert.match(f.errors[0].message, /fixture dropbox-start failure/)
  console.log('✓ 单个窗口重载失败不阻断其余窗口和服务；仅恢复失败也有统一提示')
}
