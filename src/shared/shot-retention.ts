/**
 * 截图保留期（#53）：纯计算「哪些截图过期该删」。
 * 落盘截图是隐私高敏资产 → 到期自动清。retentionDays<=0 视为「永久保留」（不清）。
 */
export interface ShotRef {
  id: string
  createdAtMs: number
}

/** 返回 createdAt 早于 (now - retentionDays) 的 id；retentionDays<=0 不清理。 */
export function expiredShotIds(refs: ShotRef[], retentionDays: number, nowMs: number): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return []
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000
  return refs.filter((r) => Number.isFinite(r.createdAtMs) && r.createdAtMs < cutoff).map((r) => r.id)
}
