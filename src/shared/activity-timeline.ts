export type ActivityState = 'active' | 'idle' | 'locked' | 'suspended' | 'paused' | 'unknown'

export interface ActivityInterval {
  id: string
  sessionId: string
  startMs: number
  endMs: number
  state: ActivityState
  appName: string | null
  bundleId: string | null
  historyAllowed: boolean
  endReason: string
}

export interface ActivityObservation {
  atMs: number
  monotonicMs?: number
  state: ActivityState
  appName?: string | null
  bundleId?: string | null
  historyAllowed?: boolean
  idleSeconds?: number
  reason?: string
}

export const ACTIVITY_IDLE_SECONDS = 60
export const ACTIVITY_MAX_HEARTBEAT_GAP_MS = 10_000

/** Sampling confirms only the time through its latest heartbeat; restarts never fill gaps. */
export class ActivityTimeline {
  private current: ActivityInterval | null = null
  private last: ActivityObservation | null = null
  private sequence = 0
  private highWaterMs = -Infinity

  readonly sessionId: string

  constructor(sessionId: string) { this.sessionId = sessionId }

  observe(input: ActivityObservation): ActivityInterval[] {
    if (!Number.isFinite(input.atMs)) return []
    if (input.atMs < this.highWaterMs) {
      const closed = this.current ? [{ ...this.current, endReason: 'clock-change' }] : []
      this.current = null
      this.last = input
      return closed.flatMap(splitActivityIntervalByDay)
    }
    this.highWaterMs = input.atMs
    const observation = { ...input }
    if (observation.state === 'active' && (observation.idleSeconds ?? 0) >= ACTIVITY_IDLE_SECONDS) {
      observation.state = 'idle'
    }
    const changed: ActivityInterval[] = []
    const previous = this.last
    const elapsed = previous ? observation.atMs - previous.atMs : 0
    const monotonicElapsed = previous?.monotonicMs != null && observation.monotonicMs != null
      ? observation.monotonicMs - previous.monotonicMs : elapsed
    const clockJump = previous != null && (elapsed < 0 || Math.abs(elapsed - monotonicElapsed) > 1_000)
    // Duplicate and stale callbacks cannot reopen or extend a committed interval.
    if (previous && elapsed === 0 && this.sameState(observation)) return []
    if (clockJump || (previous && monotonicElapsed > ACTIVITY_MAX_HEARTBEAT_GAP_MS)) {
      if (this.current) changed.push({ ...this.current, endReason: clockJump ? 'clock-change' : 'collector-gap' })
      this.current = null
    }
    if (this.current) {
      if (observation.atMs < this.current.endMs) {
        this.current = null
      } else {
        let confirmedEnd = observation.atMs
        if (this.current.state === 'active' && observation.state === 'idle') {
          confirmedEnd = Math.max(this.current.endMs, Math.min(observation.atMs,
            observation.atMs - (observation.idleSeconds ?? ACTIVITY_IDLE_SECONDS) * 1_000 + ACTIVITY_IDLE_SECONDS * 1_000))
        }
        const same = this.sameState(observation)
        // Lifecycle/unknown signals cannot certify the unobserved time since the last heartbeat.
        const confirmsTime = observation.state === 'active' || observation.state === 'idle'
        if (same || confirmsTime) this.current.endMs = confirmedEnd
        this.current.endReason = same ? 'heartbeat' : observation.reason ?? observation.state
        changed.push({ ...this.current })
        if (!same) this.current = null
      }
    }
    if (!this.current) {
      this.current = {
        id: `${this.sessionId}:${++this.sequence}`,
        sessionId: this.sessionId,
        startMs: observation.atMs,
        endMs: observation.atMs,
        state: observation.state,
        appName: observation.state === 'active' ? observation.appName ?? null : null,
        bundleId: observation.state === 'active' ? observation.bundleId ?? null : null,
        historyAllowed: observation.state === 'active' && observation.historyAllowed === true,
        endReason: observation.reason ?? 'heartbeat'
      }
      changed.push({ ...this.current })
    }
    this.last = observation
    const result = changed.flatMap(splitActivityIntervalByDay)
    if (this.current) this.current = splitActivityIntervalByDay(this.current).at(-1) ?? null
    return result
  }

  private sameState(observation: ActivityObservation): boolean {
    const current = this.current
    if (!current || current.state !== observation.state) return false
    return current.state !== 'active' || (
      current.appName === (observation.appName ?? null) &&
      current.bundleId === (observation.bundleId ?? null) &&
      current.historyAllowed === (observation.historyAllowed === true)
    )
  }
}

export function splitActivityIntervalByDay(interval: ActivityInterval): ActivityInterval[] {
  const result: ActivityInterval[] = []
  let startMs = interval.startMs
  const baseId = interval.id.replace(/@\d+$/, '')
  do {
    const date = new Date(startMs)
    const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
    const endMs = Math.min(interval.endMs, nextDay)
    result.push({ ...interval, id: `${baseId}@${startMs}`, startMs, endMs })
    startMs = endMs
  } while (startMs < interval.endMs)
  return result
}

export function activityUsage(intervals: ActivityInterval[], fromMs: number, toMs: number): { app: string; seconds: number }[] {
  const totals = new Map<string, number>()
  for (const interval of intervals) {
    if (interval.state !== 'active' || !interval.appName) continue
    const ms = Math.max(0, Math.min(interval.endMs, toMs) - Math.max(interval.startMs, fromMs))
    totals.set(interval.appName, (totals.get(interval.appName) ?? 0) + ms)
  }
  return [...totals].map(([app, ms]) => ({ app, seconds: ms / 1_000 })).sort((a, b) => b.seconds - a.seconds)
}
