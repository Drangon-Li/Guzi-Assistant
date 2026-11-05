// 活动事件的内存缓冲：保留期 + 条数上限 + 窗口内去重。
//
// 语义与「每来一条就 dedupeActivityEvents([...全部, 新事件]) 再按保留期过滤、截尾」完全一致，
// 但那样每条事件都要把几千条事件重新排序、重算签名——缓冲满时单条事件在主线程上要几十毫秒。
// 这里利用一个不变量走增量路径：
//
//   缓冲已经是 dedupeActivityEvents 的不动点（按时间有序、窗口内无等价事件）时，
//   追加一条时间不早于末尾的事件，旧事件的去留不受影响；新事件是否被去重，
//   只取决于末尾 windowMs 内有没有签名相同的事件。
//
// 不动点的任意子集仍是不动点（删掉事件只会拉大同签名事件的间隔），所以保留期过滤、
// 截尾、按范围清除都不会破坏它。只有两种情况退回整体去重：
// - suppressed 事件按原有行为不去重直接追加，之后缓冲可能不再是不动点；
// - 新事件时间早于末尾（乱序）或时间戳无效。
import { ACTIVITY_DEDUPE_WINDOW_MS, activityEventSignature, dedupeActivityEvents, type ActivityEvent } from './activity-events.ts'

export interface ActivityAppendResult {
  /** 新事件是否被接受（未被去重）；按原有语义在保留期过滤之前判定 */
  accepted: boolean
  /** 这次追加后不再在缓冲里的事件 id（含被去重的新事件），调用方据此清理旁路状态 */
  removedIds: string[]
}

const validTimestamp = (value: number): boolean => Number.isFinite(value) && value >= 0

export class ActivityEventBuffer {
  private items: ActivityEvent[] = []
  private deduped = true
  private readonly retentionMs: number
  private readonly maxEvents: number
  private readonly windowMs: number

  // 测试直接跑 .ts（Node strip-types），不支持构造函数参数属性
  constructor(retentionMs: number, maxEvents: number, windowMs = ACTIVITY_DEDUPE_WINDOW_MS) {
    this.retentionMs = retentionMs
    this.maxEvents = maxEvents
    this.windowMs = windowMs
  }

  /** 只读视图；不要保存引用，缓冲会原地增删 */
  get events(): readonly ActivityEvent[] {
    return this.items
  }

  append(event: ActivityEvent, nowMs: number): ActivityAppendResult {
    const cutoff = nowMs - this.retentionMs
    if (event.suppressed) {
      this.items.push(event)
      this.deduped = false
      return { accepted: true, removedIds: this.trimAny(cutoff) }
    }
    // 不动点里无效时间戳只会排在末尾，所以末尾有效 ⇒ 全部有效且有序
    const last = this.items.at(-1)
    const inOrder = validTimestamp(event.occurredAtMs) &&
      (!last || (validTimestamp(last.occurredAtMs) && event.occurredAtMs >= last.occurredAtMs))
    if (this.deduped && inOrder) {
      if (this.hasRecentEquivalent(event)) {
        // 被去重的事件从没进过缓冲，但保留期仍按 nowMs 推进
        return { accepted: false, removedIds: [event.id, ...this.trimSorted(cutoff)] }
      }
      this.items.push(event)
      return { accepted: true, removedIds: this.trimSorted(cutoff) }
    }
    const before = [...this.items, event]
    this.items = dedupeActivityEvents(before)
    this.deduped = true
    const accepted = this.items.some((item) => item.id === event.id)
    this.trimAny(cutoff)
    const kept = new Set(this.items.map((item) => item.id))
    return { accepted, removedIds: before.filter((item) => !kept.has(item.id)).map((item) => item.id) }
  }

  /** 只保留满足条件的事件，返回被删掉的 id */
  retain(keep: (event: ActivityEvent) => boolean): string[] {
    const removed: string[] = []
    this.items = this.items.filter((item) => {
      if (keep(item)) return true
      removed.push(item.id)
      return false
    })
    return removed
  }

  private hasRecentEquivalent(event: ActivityEvent): boolean {
    const floor = event.occurredAtMs - this.windowMs
    let signature: string | null = null
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      if (item.occurredAtMs < floor) break
      signature ??= activityEventSignature(event)
      if (activityEventSignature(item) === signature) return true
    }
    return false
  }

  /** 等价于 items.filter(保留期内).slice(-maxEvents)，适用于任意顺序；返回被删掉的 id */
  private trimAny(cutoff: number): string[] {
    const removed = this.retain((item) => item.occurredAtMs >= cutoff)
    return removed.concat(this.dropOverflow())
  }

  /** 同上，但要求缓冲按时间升序且时间戳全部有效：过期的只可能是前缀，不用整表过滤 */
  private trimSorted(cutoff: number): string[] {
    let expired = 0
    while (expired < this.items.length && this.items[expired].occurredAtMs < cutoff) expired++
    const removed = expired ? this.items.splice(0, expired).map((item) => item.id) : []
    return removed.concat(this.dropOverflow())
  }

  private dropOverflow(): string[] {
    const overflow = this.items.length - this.maxEvents
    return overflow > 0 ? this.items.splice(0, overflow).map((item) => item.id) : []
  }
}
