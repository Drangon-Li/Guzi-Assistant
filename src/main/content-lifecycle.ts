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
