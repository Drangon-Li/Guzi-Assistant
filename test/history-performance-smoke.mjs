import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CollectorPolicy } from '../src/main/history/collector-policy.ts'
import { HistorySegmentStore } from '../src/main/history/event-store.ts'

const DEFAULT_SOAK_MS = 1_500
const soakValue = Number(process.env.HISTORY_SOAK_MS ?? DEFAULT_SOAK_MS)
const soakMs = Number.isFinite(soakValue) && soakValue > 0 ? Math.trunc(soakValue) : DEFAULT_SOAK_MS
const batchSizeValue = Number(process.env.HISTORY_PERF_BATCH ?? 64)
const batchSize = Number.isFinite(batchSizeValue) && batchSizeValue > 0 ? Math.min(512, Math.trunc(batchSizeValue)) : 64

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[index].toFixed(3))
}

function processSnapshot() {
  return {
    atMs: performance.now(),
    cpu: process.cpuUsage(),
    rssBytes: process.memoryUsage().rss
  }
}

function cpuDeltaPercent(before, after) {
  const elapsedMs = Math.max(0.001, after.atMs - before.atMs)
  const cpuMicros =
    Math.max(0, after.cpu.user - before.cpu.user) + Math.max(0, after.cpu.system - before.cpu.system)
  return Number(((cpuMicros / 1_000) / elapsedMs * 100).toFixed(3))
}

function windowServerSnapshot() {
  if (process.platform !== 'darwin') return { available: false, reason: 'non-darwin' }
  try {
    // `ps` is read-only; do not infer or manipulate any process state.
    const output = execFileSync('ps', ['-axo', 'pid=,comm=,%cpu=,rss='], { encoding: 'utf8', timeout: 5_000 })
    for (const line of output.split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 4) continue
      const command = fields.slice(1, -2).join(' ')
      if (command !== 'WindowServer' && !command.endsWith('/WindowServer')) continue
      const cpuPercent = Number(fields.at(-2))
      const rssKb = Number(fields.at(-1))
      if (Number.isFinite(cpuPercent) && Number.isFinite(rssKb))
        return { available: true, cpuPercent, rssBytes: Math.max(0, rssKb) * 1024 }
    }
    return { available: false, reason: 'WindowServer-not-found' }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message.slice(0, 120) : String(error) }
  }
}

function makeIndex() {
  const rows = new Map()
  return {
    upsert(row) { rows.set(row.id, structuredClone(row)) },
    remove(id) { rows.delete(id) },
    get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null },
    list() { return [...rows.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)).map((row) => structuredClone(row)) },
    count() { return rows.size }
  }
}

function makeEvent(sequence, nowMs) {
  const input = sequence % 10 === 0
  return {
    id: `history-perf-${sequence}`,
    occurredAtMs: nowMs,
    kind: input ? 'input_activity' : sequence % 3 === 0 ? 'click' : 'window_changed',
    source: 'collector',
    appName: sequence % 2 ? 'Code' : 'Safari',
    bundleId: sequence % 2 ? 'com.microsoft.VSCode' : 'com.apple.Safari',
    windowTitle: sequence % 2 ? 'history-performance.ts' : 'Documentation',
    urlHost: sequence % 2 ? null : 'docs.example.test',
    // The collector uses window identity for dedupe; keep this only in memory.
    windowId: sequence,
    targetRole: input ? 'AXTextField' : 'AXButton',
    inputLength: input ? 1 + (sequence % 32) : null,
    command: input ? 'input_burst' : 'pointer_action',
    modifiers: []
  }
}

const root = await mkdtemp(join(tmpdir(), 'guzi-history-performance-'))
const index = makeIndex()
const store = new HistorySegmentStore({ rootDir: root, index, maxQueue: 20_000 })
const policy = new CollectorPolicy({
  dedupeWindowMs: 1,
  maxEventsPerSecond: 250_000,
  backoffBaseMs: 10,
  backoffMaxMs: 100
})
const submissionLatency = []
const deliveryLatency = []
const inputLatency = []
let accepted = 0
let dropped = 0
let sequence = 0
const before = processSnapshot()
const windowBefore = windowServerSnapshot()
const startedAt = performance.now()

try {
  await store.start()
  while (performance.now() - startedAt < soakMs) {
    const batch = []
    for (let i = 0; i < batchSize; i += 1) {
      const nowMs = Date.now()
      const event = makeEvent(sequence, nowMs)
      const submittedAt = performance.now()
      const decision = policy.accept(event, nowMs)
      const acceptedAt = performance.now()
      submissionLatency.push(acceptedAt - submittedAt)
      if (event.kind === 'input_activity') inputLatency.push(acceptedAt - submittedAt)
      if (!decision.accepted) {
        dropped += 1
        sequence += 1
        continue
      }
      accepted += 1
      batch.push({ event, submittedAt })
      sequence += 1
    }
    for (const item of batch) store.append(item.event)
    await store.flush()
    const deliveredAt = performance.now()
    for (const item of batch) deliveryLatency.push(deliveredAt - item.submittedAt)
  }
  await store.flush()
  const after = processSnapshot()
  const windowAfter = windowServerSnapshot()
  const snapshots = await store.listSegmentSnapshots()
  const delivered = snapshots.reduce((sum, snapshot) => sum + snapshot.events.length, 0)
  const metrics = {
    durationMs: Number((after.atMs - before.atMs).toFixed(3)),
    generated: sequence,
    accepted,
    dropped,
    delivered,
    segments: snapshots.length,
    latencyMs: {
      submitP50: percentile(submissionLatency, 50),
      submitP95: percentile(submissionLatency, 95),
      deliveryP50: percentile(deliveryLatency, 50),
      deliveryP95: percentile(deliveryLatency, 95),
      inputP50: percentile(inputLatency, 50),
      inputP95: percentile(inputLatency, 95)
    },
    node: {
      cpuPercent: cpuDeltaPercent(before, after),
      rssBeforeBytes: before.rssBytes,
      rssAfterBytes: after.rssBytes,
      rssDeltaBytes: after.rssBytes - before.rssBytes
    },
    windowServer: {
      before: windowBefore,
      after: windowAfter,
      cpuDeltaPercent:
        windowBefore.available && windowAfter.available
          ? Number((windowAfter.cpuPercent - windowBefore.cpuPercent).toFixed(3))
          : null,
      rssDeltaBytes:
        windowBefore.available && windowAfter.available
          ? windowAfter.rssBytes - windowBefore.rssBytes
          : null
    },
    policy: policy.snapshot()
  }

  assert.ok(metrics.generated > 0, 'synthetic load generated no events')
  assert.ok(metrics.accepted > 0, 'collector policy accepted no events')
  assert.equal(metrics.delivered, metrics.accepted, 'accepted events were not delivered to the store')
  assert.ok(Number.isFinite(metrics.node.cpuPercent) && metrics.node.cpuPercent >= 0)
  assert.ok(Number.isFinite(metrics.latencyMs.deliveryP95) && metrics.latencyMs.deliveryP95 < 30_000)
  assert.ok(metrics.node.rssAfterBytes > 0)
  for (const sample of [windowBefore, windowAfter]) {
    if (sample.available) {
      assert.ok(Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= 0)
      assert.ok(Number.isFinite(sample.rssBytes) && sample.rssBytes >= 0)
    }
  }

  console.log(`✓ synthetic History load delivered ${metrics.delivered} events across ${metrics.segments} segment(s)`)
  console.log(`✓ delivery latency p50/p95: ${metrics.latencyMs.deliveryP50}ms / ${metrics.latencyMs.deliveryP95}ms`)
  console.log(`✓ input latency p50/p95: ${metrics.latencyMs.inputP50}ms / ${metrics.latencyMs.inputP95}ms`)
  console.log(JSON.stringify(metrics, null, 2))
  console.log('\nHistory performance checks passed (真机 30 分钟 soak 未在此脚本中自动运行)')
} finally {
  await store.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
