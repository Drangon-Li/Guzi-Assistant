export interface ScreenSnapshot {
  observedAtMs: number
  pid: number
  windowId: number | null
  name: string
  bundleId: string
  windowTitle: string
  accessibility: 'available' | 'unavailable' | 'unknown'
  focusedRole: string | null
  focusedSubrole: string | null
  secureInput: boolean | null
}

export function parseScreenSnapshot(raw: unknown): ScreenSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.name !== 'string' || typeof value.bundleId !== 'string' ||
      typeof value.windowTitle !== 'string' || typeof value.observedAtMs !== 'number' ||
      !Number.isFinite(value.observedAtMs) || typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0) return null
  return {
    observedAtMs: value.observedAtMs, pid: value.pid, name: value.name,
    bundleId: value.bundleId, windowTitle: value.windowTitle,
    windowId: typeof value.windowId === 'number' && Number.isSafeInteger(value.windowId) && value.windowId > 0 ? value.windowId : null,
    accessibility: value.accessibility === 'available' || value.accessibility === 'unavailable' ? value.accessibility : 'unknown',
    focusedRole: typeof value.focusedRole === 'string' ? value.focusedRole : null,
    focusedSubrole: typeof value.focusedSubrole === 'string' ? value.focusedSubrole : null,
    secureInput: typeof value.secureInput === 'boolean' ? value.secureInput : null
  }
}

export function snapshotSafetyReason(snapshot: ScreenSnapshot | null, nowMs = Date.now()): string | null {
  if (!snapshot) return '无法读取前台窗口，已暂停截图'
  if (nowMs - snapshot.observedAtMs > 5000 || snapshot.observedAtMs > nowMs + 1000) return '前台窗口快照已过期，已暂停截图'
  if (!snapshot.name.trim()) return '无法确定前台应用身份，已暂停截图'
  if (!snapshot.windowId) return '无法确定前台窗口身份，已暂停截图'
  if (snapshot.secureInput === true || /secure|password/i.test(`${snapshot.focusedRole ?? ''} ${snapshot.focusedSubrole ?? ''}`)) return '安全输入窗口，已暂停截图'
  if (snapshot.accessibility !== 'available' || snapshot.secureInput !== false || !snapshot.focusedRole) return '辅助功能安全状态未知，已暂停截图'
  return null
}

export function snapshotContext(snapshot: ScreenSnapshot) {
  return {
    name: snapshot.name, bundleId: snapshot.bundleId, windowTitle: snapshot.windowTitle,
    windowId: snapshot.windowId ?? undefined, focusedRole: snapshot.focusedRole ?? undefined,
    focusedSubrole: snapshot.focusedSubrole ?? undefined,
    secureInput: snapshot.secureInput ?? undefined
  }
}

export function screenWindowKey(snapshot: ScreenSnapshot): string {
  return JSON.stringify([snapshot.bundleId, snapshot.pid, snapshot.windowId])
}

export function sameScreenContext(a: ScreenSnapshot, b: ScreenSnapshot): boolean {
  return screenWindowKey(a) === screenWindowKey(b) && a.windowTitle === b.windowTitle &&
    a.focusedRole === b.focusedRole && a.focusedSubrole === b.focusedSubrole
}

export class ScreenCaptureBlocked extends Error {}

export async function captureVerifiedWindow(options: {
  initial: ScreenSnapshot | null
  readSnapshot: () => Promise<ScreenSnapshot | null>
  privacyReason: (snapshot: ScreenSnapshot) => string | null
  capture: (windowId: number, signal?: AbortSignal) => Promise<string | null>
  remove: (path: string) => Promise<void>
  signal?: AbortSignal
}): Promise<string | null> {
  let path: string | null = null
  const validate = (next: ScreenSnapshot | null): ScreenSnapshot => {
    options.signal?.throwIfAborted()
    const reason = snapshotSafetyReason(next) || (next && options.privacyReason(next))
    if (reason || !next) throw new ScreenCaptureBlocked(reason || '前台窗口不可用')
    if (options.initial && !sameScreenContext(options.initial, next)) throw new ScreenCaptureBlocked('截图期间窗口或焦点发生变化，已丢弃截图')
    return next
  }
  try {
    validate(options.initial)
    const before = validate(await options.readSnapshot())
    path = await options.capture(before.windowId!, options.signal)
    validate(await options.readSnapshot())
    return path
  } catch (error) {
    if (path) await options.remove(path)
    throw error
  }
}
