// 前台应用采样只持久化应用与活动时段，不保存窗口、网页或 Accessibility 内容。
import { powerMonitor } from 'electron'
import { randomUUID } from 'crypto'
import { dayKey } from '@shared/work-report'
import { ActivityTimeline, ACTIVITY_IDLE_SECONDS, type ActivityObservation } from '@shared/activity-timeline'
import { addAppSwitch, addAppUsage } from './db'
import { persistActivityIntervals, usesTimelineForDay } from './db/activity-timeline.ts'
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
let lastSwitchApp: string | null = null
let lastActiveEndMs = 0
let isPaused: () => boolean = () => false
let historyAllowed: () => boolean = () => true
let lastSampleAtMs = 0

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
    if (interval.state === 'active' && interval.appName) {
      // Retain the legacy table as a rollback projection; interval snapshots never use += twice.
      if (deltaMs > 0 && usesTimelineForDay(dayKey(new Date(interval.startMs)))) addAppUsage(dayKey(new Date(interval.startMs)), interval.appName, deltaMs / 1_000)
      lastActiveEndMs = interval.endMs
      if (interval.endReason === 'collector-gap' || interval.endReason === 'clock-change') {
        if (lastSwitchApp) addAppSwitch(lastSwitchApp, '', interval.endMs)
        lastSwitchApp = null
        continue
      }
      if (lastSwitchApp !== interval.appName) {
        addAppSwitch(lastSwitchApp, interval.appName, interval.startMs)
        lastSwitchApp = interval.appName
      }
    } else if (lastSwitchApp) {
      addAppSwitch(lastSwitchApp, '', lastActiveEndMs)
      lastSwitchApp = null
    }
  }
  if (creditedEnds.size > 1_000) {
    const expired = [...creditedEnds.keys()].slice(0, 500)
    for (const id of expired) creditedEnds.delete(id)
  }
}

function systemState(state: 'locked' | 'suspended' | 'unknown', reason: string): void {
  generation++
  lastSampleAtMs = Date.now()
  observe({ atMs: lastSampleAtMs, state, reason })
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
      lastSampleAtMs = Date.now()
      observe({ atMs: lastSampleAtMs, state: suspended ? 'suspended' : locked ? 'locked' : 'paused' })
      return
    }
    const context = await getFrontmostContext()
    if (epoch !== generation || suspended || locked || isPaused()) return
    const now = Date.now()
    const credit = Math.min(Math.max(0, Math.round((now - lastSampleAtMs) / 1_000)), SAMPLE_SEC * 2)
    lastSampleAtMs = now
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
    if (!usesTimelineForDay(dayKey(new Date(now))) && credit > 0) addAppUsage(dayKey(new Date(now)), context.name, credit)
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
  lastSampleAtMs = Date.now()
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
  lastSwitchApp = null
  lastActiveEndMs = 0
  creditedEnds.clear()
}
