/** 带 TTL 的冷却表：screenwatch 内容冷却与 clipwatch 剪贴板冷却共用，替代各自手写的 Map + 过期清扫。 */
export class CooldownMap {
  private readonly entries = new Map<string, number>()

  constructor(private readonly ttlMs: number) {}

  /** 清理过期项，避免 Map 无界增长；每轮判定前调用。 */
  sweep(nowMs = Date.now()): void {
    for (const [key, expiry] of this.entries) if (expiry <= nowMs) this.entries.delete(key)
  }

  /** 冷却截止时刻；不在冷却期返回 null（供外部决策函数消费）。 */
  untilMs(key: string): number | null {
    return this.entries.get(key) ?? null
  }

  start(key: string, nowMs = Date.now()): void {
    this.entries.set(key, nowMs + this.ttlMs)
  }

  clear(): void {
    this.entries.clear()
  }
}
