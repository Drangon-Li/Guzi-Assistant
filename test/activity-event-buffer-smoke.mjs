// ActivityEventBuffer 必须与旧的整表写法逐条等价：
//   dedupeActivityEvents([...events, e]).filter(保留期).slice(-max)
// 用固定种子的随机序列对拍（含 suppressed、乱序、相同时刻、无效时间戳、按范围清除），
// 再测一次满缓冲时的单条耗时，防止有人把它改回整表重算。
// Run: node test/activity-event-buffer-smoke.mjs
import { ActivityEventBuffer } from '../src/shared/activity-event-buffer.ts'
import { dedupeActivityEvents } from '../src/shared/activity-events.ts'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed++
}

// 旧实现，原样搬自 activity-tracker.ts 的 appendEvent
class Reference {
  constructor(retentionMs, max) {
    this.retentionMs = retentionMs
    this.max = max
    this.events = []
  }
  append(event, nowMs) {
    const next = event.suppressed ? [...this.events, event] : dedupeActivityEvents([...this.events, event])
    const accepted = event.suppressed || next.some((item) => item.id === event.id)
    this.events = next.filter((item) => item.occurredAtMs >= nowMs - this.retentionMs).slice(-this.max)
    return accepted
  }
  retain(keep) {
    this.events = this.events.filter(keep)
  }
}

// mulberry32：固定种子，失败可复现
function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const APPS = ['Code', 'Safari', '微信']
const KINDS = ['click', 'ax_focus_changed', 'input_activity']

function runScenario(seed, steps) {
  const rand = rng(seed)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const RETENTION = 20_000
  const MAX = 25
  const buffer = new ActivityEventBuffer(RETENTION, MAX)
  const ref = new Reference(RETENTION, MAX)
  let clock = 1_000_000
  let n = 0
  for (let step = 0; step < steps; step++) {
    const roll = rand()
    if (roll < 0.04) {
      // 按范围清除（clearHistoryEvidence / status 的保留期过滤都走 retain）
      const from = clock - Math.floor(rand() * 15_000)
      const to = from + Math.floor(rand() * 5_000)
      const keep = (item) => item.occurredAtMs < from || item.occurredAtMs >= to
      const beforeIds = buffer.events.map((item) => item.id)
      const removed = buffer.retain(keep)
      ref.retain(keep)
      const afterIds = new Set(buffer.events.map((item) => item.id))
      if (removed.sort().join() !== beforeIds.filter((id) => !afterIds.has(id)).sort().join())
        return `seed ${seed} step ${step}: retain removedIds mismatch`
    } else {
      const r = rand()
      // 大多正向推进；少量相同时刻、乱序、无效时间戳
      if (r < 0.75) clock += Math.floor(rand() * 900)
      else if (r < 0.85) clock += 0
      else if (r < 0.93) clock += 3_000 + Math.floor(rand() * 9_000)
      const occurredAtMs = r >= 0.93 && r < 0.97 ? clock - Math.floor(rand() * 4_000)
        : r >= 0.97 && r < 0.985 ? Number.NaN
        : r >= 0.985 ? -5
        : clock
      const suppressed = rand() < 0.12
      const event = {
        id: `e${n++}`,
        occurredAtMs,
        kind: pick(KINDS),
        source: 'accessibility',
        privacyState: suppressed ? 'excluded' : 'normal',
        ...(suppressed ? { suppressed: true } : { appName: pick(APPS), windowTitle: pick(['a', 'b']) })
      }
      const nowMs = rand() < 0.1 ? clock + Math.floor(rand() * 30_000) : clock
      const beforeIds = buffer.events.map((item) => item.id)
      const { accepted, removedIds } = buffer.append(event, nowMs)
      const expectedAccepted = ref.append(event, nowMs)
      if (accepted !== expectedAccepted) return `seed ${seed} step ${step}: accepted ${accepted} vs ${expectedAccepted}`
      const afterIds = new Set(buffer.events.map((item) => item.id))
      const expectedRemoved = [...beforeIds, event.id].filter((id) => !afterIds.has(id)).sort().join()
      if (removedIds.slice().sort().join() !== expectedRemoved)
        return `seed ${seed} step ${step}: removedIds ${removedIds} vs ${expectedRemoved}`
    }
    const got = buffer.events.map((item) => item.id).join()
    const want = ref.events.map((item) => item.id).join()
    if (got !== want) return `seed ${seed} step ${step}:\n    got  ${got}\n    want ${want}`
  }
  return null
}

let mismatch = null
for (let seed = 1; seed <= 300 && !mismatch; seed++) mismatch = runScenario(seed, 400)
check('300 个随机序列 × 400 步与旧整表写法逐条一致', mismatch === null, mismatch ?? '')

// 满缓冲性能：旧写法每条几十毫秒，增量路径应在亚毫秒量级。阈值放得很宽，只防退化回整表重算。
{
  const MAX = 5000
  const buffer = new ActivityEventBuffer(48 * 3_600_000, MAX)
  const base = Date.now() - 3_600_000
  const mk = (i) => ({
    id: `p${i}`, occurredAtMs: base + i * 700, kind: i % 3 ? 'click' : 'ax_focus_changed', source: 'accessibility',
    privacyState: 'normal', appName: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode',
    windowTitle: `activity-tracker.ts ${i % 50}`, safeLabel: `编辑器 ${i % 7}`, targetId: `btn${i % 11}`
  })
  for (let i = 0; i < MAX; i++) buffer.append(mk(i), base + i * 700)
  const N = 500
  const start = performance.now()
  for (let i = MAX; i < MAX + N; i++) buffer.append(mk(i), base + i * 700)
  const perEvent = (performance.now() - start) / N
  check(`满缓冲（${buffer.events.length} 条）单条追加 ${perEvent.toFixed(3)}ms < 2ms`, buffer.events.length === MAX && perEvent < 2)
}

console.log(failed ? `\n${failed} items failed` : '\nAll activity-event-buffer tests passed')
process.exit(failed ? 1 : 0)
