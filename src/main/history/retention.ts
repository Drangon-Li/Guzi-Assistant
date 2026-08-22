import type { HistoryEvent } from './event-schema'

export const HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000

function validMs(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

export function historyCutoffMs(nowMs: number): number {
  if (!validMs(nowMs)) throw new RangeError('nowMs must be a finite non-negative number')
  return nowMs - HISTORY_RETENTION_MS
}

export function isHistoryEventRetained(event: Pick<HistoryEvent, 'occurred_at'>, nowMs: number): boolean {
  const occurredAt = Date.parse(event.occurred_at)
  return Number.isFinite(occurredAt) && occurredAt >= historyCutoffMs(nowMs)
}

export function segmentRetentionExpiresAt(bucketEndMs: number): string {
  if (!validMs(bucketEndMs)) throw new RangeError('bucketEndMs must be a finite non-negative number')
  return new Date(bucketEndMs + HISTORY_RETENTION_MS).toISOString()
}

export function isSegmentExpired(bucketEndMs: number, nowMs: number): boolean {
  if (!validMs(bucketEndMs)) return true
  return bucketEndMs <= historyCutoffMs(nowMs)
}
