import type { ChildProcess } from 'child_process'
import type { OcrDetectionResult } from './windows-ocr-result.ts'

/** Completion waits for close, so a canceled request cannot leave ONNX work running. */
export function waitForOcrChild(child: ChildProcess, signal?: AbortSignal, timeoutMs = 60_000): Promise<OcrDetectionResult> {
  return new Promise((resolve, reject) => {
    let result: OcrDetectionResult | undefined
    let failure: unknown
    const stop = (reason: unknown): void => { failure ??= reason; child.kill() }
    const abort = (): void => stop(signal?.reason ?? new Error('本地 OCR 已取消'))
    const message = (payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return
      const value = payload as { result?: OcrDetectionResult; error?: string }
      if (value.error) stop(new Error(value.error))
      else if (value.result) { result = value.result; child.kill() }
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      child.removeListener('message', message)
      child.removeListener('error', error)
      child.removeListener('close', close)
    }
    const error = (reason: Error): void => { cleanup(); child.kill(); reject(reason) }
    const close = (): void => {
      cleanup()
      if (failure) reject(failure)
      else if (result) resolve(result)
      else reject(new Error('本地 OCR 进程意外退出'))
    }
    const timeout = setTimeout(() => stop(new Error('本地 OCR 超时，请缩小截图区域后重试')), timeoutMs)
    child.on('message', message)
    child.once('error', error)
    child.once('close', close)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
