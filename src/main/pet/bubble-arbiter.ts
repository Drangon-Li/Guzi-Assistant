// 移植自 openpets plugin-bubble-arbiter.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
// 改动：去插件化——pluginId→source、去掉 action/submit 回调（v1 气泡是纯提醒），保留两槽调度核心：
//   transient（优先级队列 + sticky/urgent 不打断 + 相邻同文合并）/ pinned（单槽，低优先级不能挤掉高优先级）。
// 纯调度逻辑；渲染交给 Electron 层提供的 PetBubbleSink（测试用 recorder）。

export type BubblePriority = 'low' | 'normal' | 'high' | 'urgent'
export type ArbiterSlot = 'transient' | 'pinned'
export type BubbleDismissReason = 'manual' | 'timeout' | 'replaced' | 'click' | 'unpinned'

export interface PetBubble {
  readonly text?: string
  readonly markdownHtml?: string
  readonly priority: BubblePriority
  readonly sticky?: boolean
  readonly durationMs?: number
  readonly pin?: boolean
}

export interface PetBubbleCallbacks {
  onDismiss(reason: BubbleDismissReason): void
}

export interface PetBubbleHandle {
  readonly id: string
  update(patch: Partial<PetBubble>): void
  dismiss(): void
  pin(): void
  unpin(): void
}

export type ActiveBubble = {
  readonly token: string
  readonly source: string
  readonly bubble: PetBubble
}

export interface PetBubbleSink {
  present(slot: ArbiterSlot, content: ActiveBubble | null): void
}

type Entry = {
  token: string
  source: string
  bubble: PetBubble
  callbacks: PetBubbleCallbacks
  pinned: boolean
  timeout: ReturnType<typeof setTimeout> | null
  dismissed: boolean
}

const priorityRank: Record<BubblePriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }
const defaultDurationMs = 6_000
const maxQueueLength = 16

let nextToken = 0

export class PetBubbleArbiter {
  readonly #sink: PetBubbleSink
  readonly #entries = new Map<string, Entry>()
  #current: Entry | null = null
  #pinned: Entry | null = null
  readonly #queue: Entry[] = []

  constructor(sink: PetBubbleSink) {
    this.#sink = sink
  }

  static isArbiterToken(token: string): boolean {
    return token.startsWith('pet-bubble:')
  }

  show(source: string, bubble: PetBubble, callbacks: PetBubbleCallbacks): PetBubbleHandle {
    const token = `pet-bubble:${++nextToken}`
    const entry: Entry = {
      token,
      source,
      bubble,
      callbacks,
      pinned: bubble.pin === true,
      timeout: null,
      dismissed: false
    }
    this.#entries.set(token, entry)
    if (entry.pinned) this.#takePinnedSlot(entry)
    else this.#enqueue(entry)
    return {
      id: token,
      update: (patch) => this.#update(entry, patch),
      dismiss: () => this.#finish(entry, 'manual'),
      pin: () => {
        if (!entry.dismissed && !entry.pinned) {
          this.#removeFromTransient(entry)
          entry.pinned = true
          this.#takePinnedSlot(entry)
        }
      },
      unpin: () => {
        if (!entry.dismissed && entry.pinned) this.#finish(entry, 'unpinned')
      }
    }
  }

  /** 渲染层在用户点掉气泡时回调。 */
  handleDismissed(token: string): void {
    const entry = this.#entries.get(token)
    if (entry) this.#finish(entry, 'click')
  }

  /** 丢弃某来源的全部气泡（来源停用/重置）。 */
  clearSource(source: string): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.source === source) this.#finish(entry, 'manual')
    }
  }

  snapshot(): { current: ActiveBubble | null; pinned: ActiveBubble | null; queued: number } {
    return {
      current: this.#current ? toActive(this.#current) : null,
      pinned: this.#pinned ? toActive(this.#pinned) : null,
      queued: this.#queue.length
    }
  }

  #enqueue(entry: Entry): void {
    // 合并：同来源、相邻、同文 → 丢弃。
    const tail = this.#queue[this.#queue.length - 1] ?? this.#current
    if (
      tail &&
      !tail.dismissed &&
      tail.source === entry.source &&
      tail.bubble.text !== undefined &&
      tail.bubble.text === entry.bubble.text &&
      tail.bubble.markdownHtml === entry.bubble.markdownHtml
    ) {
      this.#entries.delete(entry.token)
      entry.dismissed = true
      entry.callbacks.onDismiss('replaced')
      return
    }
    if (this.#queue.length >= maxQueueLength) {
      const evicted = this.#queue.shift()!
      this.#finishDetached(evicted, 'replaced')
    }
    if (this.#current === null) {
      this.#display(entry)
      return
    }
    const currentRank = priorityRank[this.#current.bubble.priority]
    const incomingRank = priorityRank[entry.bubble.priority]
    const interruptible = !(this.#current.bubble.sticky === true || this.#current.bubble.priority === 'urgent')
    if (incomingRank > currentRank && interruptible) {
      const displaced = this.#current
      this.#queue.unshift(entry)
      this.#finish(displaced, 'replaced')
      return
    }
    this.#queue.push(entry)
    this.#queue.sort((a, b) => priorityRank[b.bubble.priority] - priorityRank[a.bubble.priority])
  }

  #display(entry: Entry): void {
    this.#current = entry
    this.#sink.present('transient', toActive(entry))
    if (!entry.bubble.sticky) {
      const duration = entry.bubble.durationMs ?? defaultDurationMs
      entry.timeout = setTimeout(() => this.#finish(entry, 'timeout'), duration)
      entry.timeout.unref?.()
    } else if (entry.bubble.durationMs !== undefined) {
      entry.timeout = setTimeout(() => this.#finish(entry, 'timeout'), entry.bubble.durationMs)
      entry.timeout.unref?.()
    }
  }

  #takePinnedSlot(entry: Entry): void {
    const existing = this.#pinned
    if (existing && existing !== entry) {
      // 低优先级不能挤掉高优先级。
      if (priorityRank[entry.bubble.priority] < priorityRank[existing.bubble.priority]) {
        this.#finishDetached(entry, 'replaced')
        return
      }
      this.#pinned = null
      this.#finishDetached(existing, 'replaced')
    }
    this.#pinned = entry
    this.#sink.present('pinned', toActive(entry))
    if (entry.bubble.durationMs !== undefined) {
      entry.timeout = setTimeout(() => this.#finish(entry, 'timeout'), entry.bubble.durationMs)
      entry.timeout.unref?.()
    }
  }

  #update(entry: Entry, patch: Partial<PetBubble>): void {
    if (entry.dismissed) return
    entry.bubble = { ...entry.bubble, ...stripUndefined(patch), priority: patch.priority ?? entry.bubble.priority }
    if (this.#pinned === entry) this.#sink.present('pinned', toActive(entry))
    else if (this.#current === entry) this.#sink.present('transient', toActive(entry))
  }

  #removeFromTransient(entry: Entry): void {
    if (entry.timeout) {
      clearTimeout(entry.timeout)
      entry.timeout = null
    }
    const queued = this.#queue.indexOf(entry)
    if (queued >= 0) this.#queue.splice(queued, 1)
    if (this.#current === entry) {
      this.#current = null
      this.#advance()
    }
  }

  #finish(entry: Entry, reason: BubbleDismissReason): void {
    if (entry.dismissed) return
    entry.dismissed = true
    if (entry.timeout) {
      clearTimeout(entry.timeout)
      entry.timeout = null
    }
    this.#entries.delete(entry.token)
    const queued = this.#queue.indexOf(entry)
    if (queued >= 0) this.#queue.splice(queued, 1)
    if (this.#pinned === entry) {
      this.#pinned = null
      this.#sink.present('pinned', null)
    }
    if (this.#current === entry) {
      this.#current = null
      this.#advance()
    }
    entry.callbacks.onDismiss(reason)
  }

  /** 结束一个从未占用槽位的 entry。 */
  #finishDetached(entry: Entry, reason: BubbleDismissReason): void {
    if (entry.dismissed) return
    entry.dismissed = true
    if (entry.timeout) {
      clearTimeout(entry.timeout)
      entry.timeout = null
    }
    this.#entries.delete(entry.token)
    entry.callbacks.onDismiss(reason)
  }

  #advance(): void {
    const next = this.#queue.shift()
    if (next) this.#display(next)
    else this.#sink.present('transient', null)
  }
}

function toActive(entry: Entry): ActiveBubble {
  return { token: entry.token, source: entry.source, bubble: entry.bubble }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}
