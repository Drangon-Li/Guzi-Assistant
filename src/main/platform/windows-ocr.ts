import { app } from 'electron'
import { fork } from 'child_process'
import { join } from 'path'
import type { TextBox } from '../../shared/chat-layout.ts'
import { assertContentEpoch, captureContentEpoch, isContentEpochCurrent } from '../content-lifecycle.ts'
import { waitForOcrChild } from './windows-ocr-process.ts'
import { normalizeOcrResult } from './windows-ocr-result.ts'

export async function windowsOcrImageDetailed(pngPath: string, signal?: AbortSignal): Promise<TextBox[]> {
  signal?.throwIfAborted()
  const epoch = captureContentEpoch()
  const lifecycle = new AbortController()
  const activeSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal
  const modelDirectory = app.isPackaged ? join(process.resourcesPath, 'ocr') : join(app.getAppPath(), 'build', 'windows-ocr')
  const runtimePackage = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'windows-runtime', 'package.json')
  const child = fork(join(app.getAppPath(), 'out', 'main', 'windows-ocr-worker.js'), [pngPath, modelDirectory, runtimePackage], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  const quit = (): void => lifecycle.abort(new Error('谷子助手正在退出'))
  const poll = setInterval(() => {
    if (!isContentEpochCurrent(epoch)) lifecycle.abort(new Error('用户内容已清除，此次操作已失效'))
  }, 100)
  app.once('will-quit', quit)
  try {
    const result = await waitForOcrChild(child, activeSignal)
    assertContentEpoch(epoch)
    return normalizeOcrResult(result)
  } finally {
    app.removeListener('will-quit', quit)
    clearInterval(poll)
    child.kill()
  }
}
