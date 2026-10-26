import { app, dialog, type IpcMainInvokeEvent, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { ExitDraft, ExitReason, ExitRequest, ExitResponse, ExitResult, ExitDecision } from '@shared/exit-lifecycle'
import { appState, getExitWindows } from './windows'
import { setExitPreparing, flushContentWork } from './content-lifecycle'

export type { ExitReason, ExitResult } from '@shared/exit-lifecycle'
interface ExitOptions {
  beforeNormalExit: () => Promise<void>
  cancelFailedInstall: () => Promise<void>
  prepareMain?: () => Promise<void>
  resumeMain?: () => void
}
interface AwaitedResponse {
  requestId: string
  stage: 'inspect' | 'prepare'
  resolve: (payload: ExitResponse) => void
  reject: (error: Error) => void
}
let options: ExitOptions | null = null
let pendingExit: Promise<ExitResult> | null = null
let preparing = false
let terminal = false
const responses = new Map<number, AwaitedResponse>()
const work = new Set<Promise<unknown>>()
const workErrors: unknown[] = []

export function isExitPreparing(): boolean { return preparing }
export function assertExitWorkAllowed(): void {
  if (preparing || terminal) throw new Error('正在保存并退出，请稍后重试')
}
export function trackExitWork<T>(promise: Promise<T>): Promise<T> {
  work.add(promise)
  void promise.then(() => work.delete(promise), (error) => {
    work.delete(promise)
    if (preparing) workErrors.push(error)
  })
  return promise
}
async function drainWork(): Promise<void> {
  while (work.size) await Promise.allSettled([...work])
  if (workErrors.length) {
    const error = workErrors.shift()
    workErrors.length = 0
    throw error
  }
}

export function registerExitResponse(event: IpcMainInvokeEvent, value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('无效的退出响应')
  const payload = value as ExitResponse
  const awaiting = responses.get(event.sender.id)
  if (!awaiting || awaiting.requestId !== payload.requestId || awaiting.stage !== payload.stage)
    throw new Error('退出请求已失效')
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('无效的退出响应来源')
  if (payload.error !== undefined && typeof payload.error !== 'string') throw new Error('无效的退出错误')
  if (payload.stage === 'inspect' && !payload.error && (!Array.isArray(payload.drafts) || payload.drafts.some((draft) =>
    !draft || typeof draft.id !== 'string' || typeof draft.label !== 'string' || typeof draft.canSave !== 'boolean' ||
    (draft.canDiscard !== undefined && typeof draft.canDiscard !== 'boolean')))) throw new Error('无效的退出草稿')
  responses.delete(event.sender.id)
  if (payload.error) awaiting.reject(new Error(payload.error))
  else awaiting.resolve(payload)
}

function askWindow(win: BrowserWindow, request: ExitRequest): Promise<ExitResponse> {
  return new Promise((resolve, reject) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) { reject(new Error('保存窗口已关闭')); return }
    const contents = win.webContents
    const fail = (): void => settle(new Error('保存窗口已关闭或崩溃，请重新打开后重试'))
    const timer = setTimeout(() => settle(new Error('保存窗口没有响应，应用已保留打开')), request.stage === 'inspect' ? 15_000 : 180_000)
    const settle = (error?: Error, value?: ExitResponse): void => {
      clearTimeout(timer)
      contents.removeListener('destroyed', fail)
      contents.removeListener('render-process-gone', fail)
      responses.delete(contents.id)
      if (error) reject(error)
      else resolve(value as ExitResponse)
    }
    contents.once('destroyed', fail)
    contents.once('render-process-gone', fail)
    responses.set(contents.id, {
      requestId: request.requestId, stage: request.stage as 'inspect' | 'prepare',
      resolve: (value) => settle(undefined, value), reject: (error) => settle(error)
    })
    contents.send('guzi-assistant:exit-request', request)
  })
}

async function collect<T>(jobs: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(jobs)
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return results.map((result) => (result as PromiseFulfilledResult<T>).value)
}

async function prepareMain(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        await drainWork()
        await flushContentWork()
        await options?.prepareMain?.()
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('后台工作尚未保存完成，应用已保留打开')), 180_000)
      })
    ])
  } finally { if (timeout !== undefined) clearTimeout(timeout) }
}

async function choose(draft: ExitDraft, reason: ExitReason): Promise<ExitDecision | null> {
  const buttons = draft.canSave
    ? draft.canDiscard === false ? ['保存', '取消'] : ['保存', '放弃更改', '取消']
    : ['放弃输入', '取消']
  const result = await dialog.showMessageBox({ type: 'question', title: reason === 'install-update' ? '安装更新前保存' : '退出前保存',
    message: draft.label, detail: draft.canSave ? '保存完成后才会退出。取消会保留应用与当前内容。' : '这段输入尚未提交，退出会放弃输入。',
    buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true })
  if (result.response === buttons.length - 1) return null
  return draft.canSave && result.response === 0 ? 'save' : 'discard'
}

async function runExit(reason: ExitReason, commit: () => void | Promise<void>): Promise<ExitResult> {
  const requestId = randomUUID()
  const windows = getExitWindows()
  preparing = true
  setExitPreparing(true)
  let committed = false
  let cancelledInstall = false
  const cancelInstall = async (): Promise<void> => {
    if (cancelledInstall) return
    cancelledInstall = true
    await options?.cancelFailedInstall()
  }
  try {
    const inspected = await collect(windows.map((win) => askWindow(win, { requestId, stage: 'inspect', reason })))
    const decisions: Record<string, ExitDecision>[] = []
    for (const result of inspected) {
      const choice: Record<string, ExitDecision> = {}
      for (const draft of result.drafts ?? []) {
        const decision = await choose(draft, reason)
        if (!decision) {
          if (reason === 'install-update') await cancelInstall()
          return { status: 'cancelled' }
        }
        choice[draft.id] = decision
      }
      decisions.push(choice)
    }
    await collect(windows.map((win, index) => askWindow(win, { requestId, stage: 'prepare', reason, decisions: decisions[index] })))
    await prepareMain()
    if (reason !== 'install-update') await options?.beforeNormalExit()
    const currentWindows = getExitWindows()
    if (currentWindows.length !== windows.length || currentWindows.some((win) => !windows.includes(win)))
      throw new Error('保存期间窗口发生变化，请重试退出')
    appState.quitting = true
    terminal = true
    await commit()
    committed = true
    return { status: 'committed' }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    if (reason === 'install-update') {
      try { await cancelInstall() } catch (cancelError) {
        message += `；取消待安装更新失败：${cancelError instanceof Error ? cancelError.message : String(cancelError)}`
      }
    }
    return { status: 'failed', message }
  } finally {
    if (!committed) {
      terminal = false
      appState.quitting = false
      preparing = false
      setExitPreparing(false)
      options?.resumeMain?.()
      for (const win of getExitWindows()) {
        if (!win.isDestroyed()) win.webContents.send('guzi-assistant:exit-request', { requestId, stage: 'resume', reason } satisfies ExitRequest)
      }
    }
  }
}

export function requestExit(reason: ExitReason, commit: () => void | Promise<void>): Promise<ExitResult> {
  if (pendingExit) return pendingExit
  pendingExit = runExit(reason, commit).finally(() => { pendingExit = null })
  return pendingExit
}

export function installExitLifecycle(next: ExitOptions): void {
  options = next
  app.on('before-quit', (event) => {
    if (terminal) return
    event.preventDefault()
    void requestExit('quit', () => app.quit()).then((result) => {
      if (result.status === 'failed') void dialog.showMessageBox({ type: 'error', title: '未能退出', message: result.message })
    })
  })
}
