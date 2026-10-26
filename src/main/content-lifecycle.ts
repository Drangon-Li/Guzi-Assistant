let contentEpoch = 0
let resetting = false

export function isContentResetting(): boolean {
  return resetting
}

export function captureContentEpoch(): number {
  if (resetting) throw new Error('正在清除用户内容，请稍后重试')
  return contentEpoch
}

export function isContentEpochCurrent(epoch: number): boolean {
  return !resetting && epoch === contentEpoch
}

export function assertContentEpoch(epoch: number): void {
  if (!isContentEpochCurrent(epoch)) throw new Error('用户内容已清除，此次操作已失效')
}

export function beginContentReset(): () => void {
  if (resetting) throw new Error('正在清除用户内容，请稍后重试')
  resetting = true
  contentEpoch += 1
  return () => { resetting = false }
}

let exitPreparing = false
const pendingExitWork = new Set<Promise<unknown>>()
const exitWorkErrors: unknown[] = []
export function setExitPreparing(value: boolean): void {
  exitPreparing = value
  if (!value) exitWorkErrors.length = 0
}
export function isExitPreparing(): boolean { return exitPreparing }
export function trackContentWork<T>(promise: Promise<T>): Promise<T> {
  pendingExitWork.add(promise)
  void promise.then(() => pendingExitWork.delete(promise), (error) => {
    pendingExitWork.delete(promise)
    if (exitPreparing) exitWorkErrors.push(error)
  })
  return promise
}
export async function flushContentWork(): Promise<void> {
  while (pendingExitWork.size) await Promise.allSettled([...pendingExitWork])
  if (exitWorkErrors.length) {
    const error = exitWorkErrors.shift()
    exitWorkErrors.length = 0
    throw error
  }
}
