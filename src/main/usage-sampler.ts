// 前台应用采样只持久化应用与活动时段，不保存窗口、网页或 Accessibility 内容。
// 时间线（activity_intervals）是唯一的计时来源；app_usage 只是从它投影出的按天汇总，供保留期之后查询。
import { powerMonitor } from 'electron'
import { randomUUID } from 'crypto'
import { dayKey } from '@shared/work-report'
import { ActivityTimeline, ACTIVITY_IDLE_SECONDS, type ActivityObservation } from '@shared/activity-timeline'
import { addAppUsage } from './db'
import { persistActivityIntervals } from './db/activity-timeline.ts'
import { getFrontmostContext } from './frontapp'
import { markActivityObserverFailure, markActivityObserverHealthy, recordFrontmostContext, getCollectorCaptureSafety } from './activity-tracker'
import { isOwnApp, privacyForContext } from './privacy'

export const IDLE_SKIP_SEC = ACTIVITY_IDLE_SECONDS
const SAMPLE_SEC = 5
let sampleTimer: ReturnType<typeof setInterval> | null = null
let sampling = false
let generation = 0
let timeline: ActivityTimeline | null = null
let locked = false
let suspended = false
let isPaused: () => boolean = () => false
let historyAllowed: () => boolean = () => true

export function configureActivityHistoryAllowed(provider: () => boolean): void { historyAllowed = provider }
const creditedEnds = new Map<string, number>()

export function resetUsageTimelineBoundary(reason = 'history_deleted'): void {
  generation++
  systemState('unknown', reason)
  timeline = timeline ? new ActivityTimeline(randomUUID()) : null
  creditedEnds.clear()
}

function observe(input: Omit<ActivityObservation, 'monotonicMs'>): void {
  if (!timeline) return
  const updates = timeline.observe({ ...input, monotonicMs: performance.now() })
  persistActivityIntervals(updates)
  for (const interval of updates) {
    const priorEnd = creditedEnds.get(interval.id) ?? interval.startMs
    const deltaMs = Math.max(0, interval.endMs - priorEnd)
    creditedEnds.set(interval.id, Math.max(priorEnd, interval.endMs))
    // 同一区间会随心跳反复更新，只把新增的那段计入汇总，不会重复累加
    if (interval.state === 'active' && interval.appName && deltaMs > 0)
      addAppUsage(dayKey(new Date(interval.startMs)), interval.appName, deltaMs / 1_000)
  }
  if (creditedEnds.size > 1_000) {
    const expired = [...creditedEnds.keys()].slice(0, 500)
    for (const id of expired) creditedEnds.delete(id)
  }
}

function systemState(state: 'locked' | 'suspended' | 'unknown', reason: string): void {
  generation++
  observe({ atMs: Date.now(), state, reason })
}
const onSuspend = (): void => { suspended = true; systemState('suspended', 'suspend') }
const onLock = (): void => { locked = true; systemState('locked', 'lock') }
const onShutdown = (): void => { suspended = true; systemState('suspended', 'shutdown') }
const onResume = (): void => { suspended = false; systemState(locked ? 'locked' : 'unknown', 'resume') }
const onUnlock = (): void => { locked = false; systemState(suspended ? 'suspended' : 'unknown', 'unlock') }

async function sampleTick(): Promise<void> {
  if (sampling) return
  sampling = true
  const epoch = generation
  try {
    if (suspended || locked || isPaused()) {
      observe({ atMs: Date.now(), state: suspended ? 'suspended' : locked ? 'locked' : 'paused' })
      return
    }
    const context = await getFrontmostContext()
    if (epoch !== generation || suspended || locked || isPaused()) return
    const now = Date.now()
    const idleSeconds = powerMonitor.getSystemIdleTime()
    if (!context?.name) {
      markActivityObserverFailure('无法读取前台应用上下文')
      observe({ atMs: now, state: 'unknown', reason: 'observer-failure' })
      return
    }
    markActivityObserverHealthy()
    if (idleSeconds >= IDLE_SKIP_SEC) {
      observe({ atMs: now, state: 'idle', idleSeconds })
      return
    }
    const privacy = privacyForContext(context)
    recordFrontmostContext(context, { suppressed: privacy.suppressed, privacyState: privacy.privacyState, nowMs: now })
    if (isOwnApp(context.name)) {
      observe({ atMs: now, state: 'unknown', reason: 'own-app' })
      return
    }
    // History exclusions have no effect on consented application-duration totals.
    const collectorSafety = getCollectorCaptureSafety(context, now)
    const historyPrivacy = privacyForContext({ ...context, urlHost: collectorSafety.urlHost }, true)
    observe({ atMs: now, state: 'active', appName: context.name, bundleId: context.bundleId,
      historyAllowed: !collectorSafety.blocked && !historyPrivacy.suppressed && historyAllowed(), idleSeconds })
  } finally {
    sampling = false
  }
}

function runSampleTick(): void {
  const epoch = generation
  void sampleTick().catch(() => { if (epoch === generation) systemState('unknown', 'sample-error') })
}

export function startUsageSampler(paused: () => boolean): void {
  stopUsageSampler()
  isPaused = paused
  locked = false
  suspended = false
  timeline = new ActivityTimeline(randomUUID())
  creditedEnds.clear()
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('lock-screen', onLock)
  powerMonitor.on('shutdown', onShutdown)
  powerMonitor.on('resume', onResume)
  powerMonitor.on('unlock-screen', onUnlock)
  runSampleTick()
  sampleTimer = setInterval(runSampleTick, SAMPLE_SEC * 1_000)
}

export function stopUsageSampler(): void {
  generation++
  if (sampleTimer) clearInterval(sampleTimer)
  sampleTimer = null
  systemState('unknown', 'stop')
  timeline = null
  powerMonitor.removeListener('suspend', onSuspend)
  powerMonitor.removeListener('lock-screen', onLock)
  powerMonitor.removeListener('shutdown', onShutdown)
  powerMonitor.removeListener('resume', onResume)
  powerMonitor.removeListener('unlock-screen', onUnlock)
  locked = false
  suspended = false
  creditedEnds.clear()
}
