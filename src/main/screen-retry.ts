import { hamming } from '../shared/phash.ts'

const CONTENT_COOLDOWN_MS = 10 * 60_000
const EMPTY_OCR_COOLDOWN_MS = 45_000

export interface ScreenAttemptState {
  observedHash: bigint | null
  successfulHash: bigint | null
  successfulTextHash: string | null
  successfulAtMs: number | null
  successfulTexts: Map<string, number>
  emptyOcrHash: bigint | null
  emptyOcrRetryAtMs: number | null
  failures: number
  retryAtMs: number
  blocked: boolean
}

export class ScreenRetryState {
  private windows = new Map<string, ScreenAttemptState>()
  state(key: string): ScreenAttemptState {
    let state = this.windows.get(key)
    if (!state) {
      state = {
        observedHash: null, successfulHash: null, successfulTextHash: null, successfulAtMs: null,
        successfulTexts: new Map(), emptyOcrHash: null, emptyOcrRetryAtMs: null,
        failures: 0, retryAtMs: 0, blocked: false
      }
      this.windows.set(key, state)
      if (this.windows.size > 200) this.windows.delete(this.windows.keys().next().value!)
    }
    return state
  }
  ready(key: string, nowMs: number): boolean {
    const state = this.state(key)
    return !state.blocked && nowMs >= state.retryAtMs && nowMs >= (state.emptyOcrRetryAtMs ?? 0)
  }
  retryDue(key: string, nowMs: number): boolean {
    const state = this.state(key)
    return (state.failures > 0 || state.emptyOcrRetryAtMs !== null) && this.ready(key, nowMs)
  }
  shouldSkipHash(key: string, hash: bigint, nowMs: number, threshold = 2): boolean {
    const state = this.state(key)
    if (state.failures > 0 || state.emptyOcrRetryAtMs !== null) return false
    return state.successfulAtMs !== null && nowMs >= state.successfulAtMs &&
      nowMs - state.successfulAtMs < CONTENT_COOLDOWN_MS && state.successfulHash !== null &&
      hamming(hash, state.successfulHash) <= threshold
  }
  shouldSkipText(key: string, textHash: string, nowMs: number): boolean {
    const state = this.state(key)
    this.pruneTexts(state, nowMs)
    if (state.failures > 0 || state.emptyOcrRetryAtMs !== null) return false
    return state.successfulTexts.has(textHash)
  }
  markEmptyOcr(key: string, hash: bigint, nowMs: number): void {
    Object.assign(this.state(key), {
      observedHash: hash, emptyOcrHash: hash, emptyOcrRetryAtMs: nowMs + EMPTY_OCR_COOLDOWN_MS,
      failures: 0, retryAtMs: 0, blocked: false
    })
  }
  fail(key: string, error: unknown, nowMs: number): void {
    const state = this.state(key)
    state.failures += 1
    state.emptyOcrHash = null
    state.emptyOcrRetryAtMs = null
    const detail = error instanceof Error ? error.message : String(error)
    const metadata = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    const retryAfter = metadata.retryAfterMs
    const status = metadata.status ?? metadata.statusCode ?? (/\b429\b/.test(detail) ? 429 : undefined)
    state.blocked = status !== 429 && (status === 401 || status === 403 || /认证|API.?key|配置错误|未配置|invalid.api.key|unauthorized|forbidden|订阅|试用|额度|积分不足|Key 被拒绝|请先填写|模型名/i.test(detail))
    const wait = [45_000, 90_000, 180_000, 300_000][Math.min(state.failures - 1, 3)]
    state.retryAtMs = nowMs + Math.max(wait, typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : 0)
  }
  succeed(key: string, hash: bigint, textHash: string, nowMs = Date.now()): void {
    const state = this.state(key)
    Object.assign(state, {
      successfulHash: hash, successfulTextHash: textHash, successfulAtMs: nowMs,
      emptyOcrHash: null, emptyOcrRetryAtMs: null, failures: 0, retryAtMs: 0, blocked: false
    })
    this.pruneTexts(state, nowMs)
    state.successfulTexts.set(textHash, nowMs)
  }
  private pruneTexts(state: ScreenAttemptState, nowMs: number): void {
    for (const [hash, atMs] of state.successfulTexts) {
      if (nowMs < atMs || nowMs - atMs >= CONTENT_COOLDOWN_MS) state.successfulTexts.delete(hash)
    }
  }
  reset(): void { this.windows.clear() }
}

export class ScanGeneration {
  private generation = 0
  private controllers = new Set<AbortController>()
  begin(): { signal: AbortSignal; current: () => boolean; finish: () => void } {
    const generation = this.generation
    const controller = new AbortController()
    this.controllers.add(controller)
    return { signal: controller.signal, current: () => generation === this.generation && !controller.signal.aborted,
      finish: () => { this.controllers.delete(controller) } }
  }
  cancel(): void {
    this.generation += 1
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }
}
