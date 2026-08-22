import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { utcTenMinuteBucket } from '../../shared/activity-events.ts'
import type { ActivityEvent } from '../../shared/activity-events.ts'
import type { HistoryStoreHealth } from '../../shared/types.ts'
import {
  convertActivityEvent,
  isMeaningfulHistoryEvent,
  parseHistoryEvent,
  type HistoryEvent
} from './event-schema.ts'
import { historyCutoffMs, isHistoryEventRetained, isSegmentExpired, segmentRetentionExpiresAt } from './retention.ts'
import type { HistorySegmentIndex, HistorySegmentMetadata } from './segment-index.ts'

const SEGMENT_DIR = 'segments'
const LOCK_FILE = '.lock'
const DEFAULT_MAX_QUEUE = 1000

export interface HistorySegmentStoreOptions {
  rootDir: string
  index: HistorySegmentIndex
  now?: () => number
  maxQueue?: number
  /** Wait for a previous store to release its lock before acquiring this one. */
  startAfter?: Promise<void>
}

interface SegmentState {
  metadata: HistorySegmentMetadata
  metadataPath: string
  eventsPath: string
  eventIds: Set<string>
}

export interface HistorySegmentSnapshot {
  metadata: HistorySegmentMetadata
  events: HistoryEvent[]
}

export interface HistorySegmentSummaryPatch {
  status: HistorySegmentMetadata['summaryStatus']
  text: string | null
  json: string | null
}

interface PersistedLine {
  event: HistoryEvent
  raw: string
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString()
}

function segmentFolder(bucketStart: string): string {
  return bucketStart.replace(/[^0-9A-Za-z._-]/g, '_')
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseLock(raw: string): { pid: number } | null {
  try {
    const value = JSON.parse(raw) as { pid?: unknown }
    return typeof value.pid === 'number' && Number.isInteger(value.pid) ? { pid: value.pid } : null
  } catch {
    return null
  }
}

/**
 * Local JSONL event store. All mutating filesystem work is serialized through
 * a bounded promise queue so the collector callback never waits on disk IO.
 */
export class HistorySegmentStore {
  private readonly rootDir: string
  private readonly segmentsDir: string
  private readonly lockPath: string
  private readonly index: HistorySegmentIndex
  private readonly now: () => number
  private readonly maxQueue: number
  private readonly startAfter: Promise<void>
  private readonly metadataCache = new Map<string, SegmentState>()
  private readonly queueTail: { promise: Promise<void> }
  private ready: Promise<void> | null = null
  private lockHandle: FileHandle | null = null
  private queueLength = 0
  private droppedCount = 0
  private suppressedCount = 0
  private invalidCount = 0
  private lastWriteAt: string | null = null
  private lastCleanupAt: string | null = null
  private lastError: string | null = null
  private currentSegmentId: string | null = null
  private state: HistoryStoreHealth['state'] = 'starting'
  private closed = false

  constructor(options: HistorySegmentStoreOptions) {
    this.rootDir = resolve(options.rootDir)
    this.segmentsDir = join(this.rootDir, SEGMENT_DIR)
    this.lockPath = join(this.rootDir, LOCK_FILE)
    this.index = options.index
    this.now = options.now ?? Date.now
    this.maxQueue = Math.max(1, Math.floor(options.maxQueue ?? DEFAULT_MAX_QUEUE))
    this.startAfter = options.startAfter ?? Promise.resolve()
    this.queueTail = { promise: Promise.resolve() }
  }

  start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.startAfter.then(() => this.initialize()).catch((error) => {
      this.ready = null
      this.fail(error)
      throw error
    })
    return this.ready
  }

  append(activity: ActivityEvent): boolean {
    if (this.closed) {
      this.droppedCount += 1
      return false
    }
    const conversion = convertActivityEvent(activity)
    if (conversion.invalid) {
      this.invalidCount += 1
      return false
    }
    if (conversion.suppressed || !conversion.event) {
      this.suppressedCount += 1
      this.enqueue(() => this.writeSuppressed(activity.occurredAtMs))
      return false
    }
    return this.enqueue(() => this.writeEvent(conversion.event as HistoryEvent))
  }

  async flush(): Promise<void> {
    await this.start()
    await this.queueTail.promise
  }

  async cleanup(nowMs = this.now()): Promise<void> {
    if (this.closed) return
    await this.start()
    // Retention rewrites the same files as append; enqueue it behind pending
    // writes so a cleanup cannot race a collector event.
    this.schedule(() => this.performCleanup(nowMs))
    await this.queueTail.promise
  }

  private async performCleanup(nowMs: number): Promise<void> {
    const cutoff = historyCutoffMs(nowMs)
    const indexed = this.index.list()
    for (const metadata of indexed) await this.cleanupSegment(metadata, cutoff, nowMs)
    this.lastCleanupAt = new Date(nowMs).toISOString()
  }

  health(): HistoryStoreHealth {
    let segmentCount = 0
    try {
      segmentCount = this.index.count()
    } catch {
      // The health endpoint must remain readable even while SQLite is unavailable.
    }
    return {
      enabled: !this.closed,
      state: this.state,
      currentSegmentId: this.currentSegmentId,
      queueLength: this.queueLength,
      droppedCount: this.droppedCount,
      suppressedCount: this.suppressedCount,
      invalidCount: this.invalidCount,
      segmentCount,
      lastWriteAt: this.lastWriteAt,
      lastCleanupAt: this.lastCleanupAt,
      lastError: this.lastError
    }
  }

  /** Return stable, sanitized event snapshots for the summary pipeline. */
  async listSegmentSnapshots(): Promise<HistorySegmentSnapshot[]> {
    await this.flush()
    const snapshots: HistorySegmentSnapshot[] = []
    for (const metadata of this.index.list()) {
      const state = this.metadataCache.get(metadata.id) ?? (await this.loadSegment(metadata))
      if (!state) continue
      const events = (await this.readEvents(state)).map((item) => item.event)
      snapshots.push({
        metadata: { ...state.metadata },
        events
      })
    }
    return snapshots
  }

  async readSegmentSnapshot(id: string): Promise<HistorySegmentSnapshot | null> {
    await this.flush()
    const metadata = this.index.get(id)
    if (!metadata) return null
    const state = this.metadataCache.get(id) ?? (await this.loadSegment(metadata))
    if (!state) return null
    const events = (await this.readEvents(state)).map((item) => item.event)
    return { metadata: { ...state.metadata }, events }
  }

  /**
   * Delete complete 10-minute segments intersecting [fromMs, toMs).
   *
   * Suppressed events do not have individual JSONL rows or timestamps, so a
   * partially overlapping segment is removed as a whole. This is the only
   * destructive operation exposed by the History service and is serialized
   * behind pending appends.
   */
  async deleteRange(fromMs: number, toMs: number): Promise<string[]> {
    if (this.closed) return []
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs)
      throw new RangeError('history delete range must satisfy from < to')
    await this.start()
    let deleted: string[] = []
    this.schedule(async () => {
      const candidates = new Map<string, HistorySegmentMetadata>()
      const orphanDirectories: string[] = []
      for (const metadata of this.index.list()) candidates.set(metadata.id, metadata)

      // Recover indexed rows that may have been written before an interrupted
      // SQLite upsert, so an explicit delete cannot leave their sidecar behind.
      const entries = await readdir(this.segmentsDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const metadataPath = join(this.segmentsDir, entry.name, 'metadata.json')
        const metadata = this.parseMetadata(await readFile(metadataPath, 'utf8').catch(() => ''))
        if (metadata) candidates.set(metadata.id, metadata)
        else if (fromMs === Number.NEGATIVE_INFINITY && toMs === Number.POSITIVE_INFINITY)
          orphanDirectories.push(join(this.segmentsDir, entry.name))
      }

      const removed: string[] = []
      for (const metadata of candidates.values()) {
        const bucketStartMs = Date.parse(metadata.bucketStart)
        const bucketEndMs = Date.parse(metadata.bucketEnd)
        if (!Number.isFinite(bucketStartMs) || !Number.isFinite(bucketEndMs)) continue
        if (bucketEndMs <= fromMs || bucketStartMs >= toMs) continue
        const dir = join(this.segmentsDir, segmentFolder(metadata.bucketStart))
        await rm(dir, { recursive: true, force: true })
        this.index.remove(metadata.id)
        this.metadataCache.delete(metadata.id)
        if (this.currentSegmentId === metadata.id) this.currentSegmentId = null
        removed.push(metadata.id)
      }
      // A full explicit clear also removes malformed orphan directories inside
      // the store-owned segments root; bounded deletes leave them untouched.
      for (const dir of orphanDirectories) await rm(dir, { recursive: true, force: true })
      deleted = [...new Set(removed)].sort()
      this.lastCleanupAt = isoNow(this.now)
    })
    await this.queueTail.promise
    return deleted
  }

  async clear(): Promise<string[]> {
    return this.deleteRange(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
  }

  /** Persist a summary without exposing the store's filesystem paths. */
  async updateSummary(id: string, patch: HistorySegmentSummaryPatch): Promise<boolean> {
    if (this.closed) return false
    await this.start()
    let updated = false
    this.schedule(async () => {
      const indexed = this.index.get(id)
      const state = this.metadataCache.get(id) ?? (indexed ? await this.loadSegment(indexed) : null)
      if (!state) return
      if (
        state.metadata.summaryStatus === patch.status &&
        state.metadata.summaryText === patch.text &&
        state.metadata.summaryJson === patch.json
      ) {
        updated = true
        return
      }
      state.metadata.summaryStatus = patch.status
      state.metadata.summaryText = patch.text
      state.metadata.summaryJson = patch.json
      state.metadata.updatedAt = isoNow(this.now)
      await this.persistMetadata(state)
      this.metadataCache.set(id, state)
      updated = true
    })
    await this.queueTail.promise
    return updated
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.flush()
    } catch {
      // Preserve the original health error while still releasing the lock.
    }
    this.closed = true
    this.state = 'stopped'
    await this.releaseLock()
  }

  private enqueue(job: () => Promise<void>): boolean {
    if (this.queueLength >= this.maxQueue) {
      this.droppedCount += 1
      return false
    }
    this.schedule(job)
    return true
  }

  private schedule(job: () => Promise<void>): void {
    this.queueLength += 1
    this.queueTail.promise = this.queueTail.promise
      .then(() => this.start())
      .then(job)
      .catch((error) => this.fail(error))
      .finally(() => {
        this.queueLength = Math.max(0, this.queueLength - 1)
      })
  }

  private async initialize(): Promise<void> {
    try {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
      await chmod(this.rootDir, 0o700).catch(() => {})
      await mkdir(this.segmentsDir, { recursive: true, mode: 0o700 })
      await chmod(this.segmentsDir, 0o700).catch(() => {})
      await this.acquireLock()
      const indexed = this.index.list()
      const loadedIds = new Set<string>()
      for (const metadata of indexed) {
        const state = await this.loadSegment(metadata)
        if (state) {
          if (state.metadata.id !== metadata.id) this.index.remove(metadata.id)
          this.metadataCache.set(state.metadata.id, state)
          loadedIds.add(state.metadata.id)
        } else {
          // The filesystem is authoritative for a segment. An index row with
          // no recoverable metadata/events is stale and must not survive boot.
          this.index.remove(metadata.id)
        }
      }
      // Recover a segment whose JSONL/metadata reached disk just before the
      // SQLite upsert, and repair an index row lost during interrupted cleanup.
      const entries = await readdir(this.segmentsDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const metadataPath = join(this.segmentsDir, entry.name, 'metadata.json')
        const metadata = this.parseMetadata(await readFile(metadataPath, 'utf8').catch(() => ''))
        if (!metadata || loadedIds.has(metadata.id)) continue
        const state = await this.loadSegment(metadata)
        if (state) {
          this.metadataCache.set(state.metadata.id, state)
          loadedIds.add(state.metadata.id)
        }
      }
      this.state = 'healthy'
    } catch (error) {
      await this.releaseLock()
      throw error
    }
  }

  private async releaseLock(): Promise<void> {
    const lockHandle = this.lockHandle
    this.lockHandle = null
    if (!lockHandle) return
    await lockHandle.close().catch(() => {})
    await unlink(this.lockPath).catch(() => {})
  }

  private async acquireLock(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    try {
      this.lockHandle = await open(this.lockPath, 'wx')
      await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, created_at: isoNow(this.now) }))
      await chmod(this.lockPath, 0o600).catch(() => {})
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const lock = parseLock(await readFile(this.lockPath, 'utf8').catch(() => ''))
    if (lock && isPidAlive(lock.pid)) throw new Error(`history store already locked by pid ${lock.pid}`)
    await unlink(this.lockPath).catch(() => {})
    this.lockHandle = await open(this.lockPath, 'wx')
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, created_at: isoNow(this.now) }))
    await chmod(this.lockPath, 0o600).catch(() => {})
  }

  /** Keep the on-disk metadata and SQLite row in a deterministic order. */
  private async persistMetadata(state: SegmentState): Promise<void> {
    state.metadata.eventsPath = relative(this.rootDir, state.eventsPath)
    await this.writeMetadata(state.metadataPath, state.metadata)
    this.index.upsert(state.metadata)
  }

  private async writeEvent(event: HistoryEvent): Promise<void> {
    const bucket = utcTenMinuteBucket(Date.parse(event.occurred_at))
    const state = await this.ensureSegment(bucket.startIso, bucket.endIso)
    if (state.eventIds.has(event.id)) return
    await appendFile(state.eventsPath, `${JSON.stringify(event)}\n`, 'utf8')
    await chmod(state.eventsPath, 0o600).catch(() => {})
    state.eventIds.add(event.id)
    state.metadata.eventCount += 1
    if (isMeaningfulHistoryEvent(event)) state.metadata.meaningfulEventCount += 1
    state.metadata.updatedAt = isoNow(this.now)
    state.metadata.retentionExpiresAt = segmentRetentionExpiresAt(Date.parse(state.metadata.bucketEnd))
    await this.persistMetadata(state)
    this.currentSegmentId = state.metadata.id
    this.lastWriteAt = state.metadata.updatedAt
  }

  private async writeSuppressed(occurredAtMs: number): Promise<void> {
    if (!Number.isFinite(occurredAtMs) || occurredAtMs < 0) return
    const bucket = utcTenMinuteBucket(occurredAtMs)
    const state = await this.ensureSegment(bucket.startIso, bucket.endIso)
    state.metadata.suppressedEventCount += 1
    state.metadata.updatedAt = isoNow(this.now)
    this.lastWriteAt = state.metadata.updatedAt
    await this.persistMetadata(state)
    this.currentSegmentId = state.metadata.id
  }

  private async ensureSegment(bucketStart: string, bucketEnd: string): Promise<SegmentState> {
    const id = `history-10m-${bucketStart}`
    const cached = this.metadataCache.get(id)
    if (cached) return cached
    const dir = join(this.segmentsDir, segmentFolder(bucketStart))
    const eventsPath = join(dir, 'events.jsonl')
    const metadataPath = join(dir, 'metadata.json')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    const stored = await readFile(metadataPath, 'utf8').then((raw) => this.parseMetadata(raw)).catch(() => null)
    const usableStored =
      stored && stored.id === id && stored.bucketStart === bucketStart && stored.bucketEnd === bucketEnd ? stored : null
    const metadata: HistorySegmentMetadata = usableStored ?? {
      id,
      bucketStart,
      bucketEnd,
      eventsPath: relative(this.rootDir, eventsPath),
      eventCount: 0,
      meaningfulEventCount: 0,
      suppressedEventCount: 0,
      summaryStatus: 'pending',
      summaryText: null,
      summaryJson: null,
      retentionExpiresAt: segmentRetentionExpiresAt(Date.parse(bucketEnd)),
      createdAt: isoNow(this.now),
      updatedAt: isoNow(this.now)
    }
    const state: SegmentState = { metadata, metadataPath, eventsPath, eventIds: new Set() }
    await this.reconcileSegment(state)
    this.metadataCache.set(id, state)
    return state
  }

  private parseMetadata(raw: string): HistorySegmentMetadata | null {
    try {
      const value = JSON.parse(raw) as Partial<HistorySegmentMetadata>
      if (
        typeof value.id !== 'string' ||
        typeof value.bucketStart !== 'string' ||
        typeof value.bucketEnd !== 'string' ||
        typeof value.eventsPath !== 'string' ||
        !Number.isFinite(value.eventCount) ||
        !Number.isFinite(value.meaningfulEventCount) ||
        !Number.isFinite(value.suppressedEventCount) ||
        typeof value.retentionExpiresAt !== 'string' ||
        typeof value.createdAt !== 'string' ||
        typeof value.updatedAt !== 'string'
      ) return null
      const bucketStartMs = Date.parse(value.bucketStart)
      const bucketEndMs = Date.parse(value.bucketEnd)
      if (
        !Number.isFinite(bucketStartMs) ||
        !Number.isFinite(bucketEndMs) ||
        bucketStartMs < 0 ||
        bucketEndMs <= bucketStartMs
      )
        return null
      const eventCount = Math.max(0, Math.trunc(value.eventCount as number))
      const meaningfulEventCount = Math.max(0, Math.trunc(value.meaningfulEventCount as number))
      const suppressedEventCount = Math.max(0, Math.trunc(value.suppressedEventCount as number))
      return {
        id: value.id,
        bucketStart: value.bucketStart,
        bucketEnd: value.bucketEnd,
        eventsPath: value.eventsPath,
        eventCount,
        meaningfulEventCount,
        suppressedEventCount,
        summaryStatus: value.summaryStatus === 'ready' || value.summaryStatus === 'failed' ? value.summaryStatus : 'pending',
        summaryText: typeof value.summaryText === 'string' ? value.summaryText : null,
        summaryJson: typeof value.summaryJson === 'string' ? value.summaryJson : null,
        retentionExpiresAt: value.retentionExpiresAt,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt
      }
    } catch {
      return null
    }
  }

  private async reconcileSegment(state: SegmentState, forcePersist = true): Promise<void> {
    const metadataBefore = JSON.stringify(state.metadata)
    let diskMetadataDrifted = false
    if (!forcePersist) {
      const diskRaw = await readFile(state.metadataPath, 'utf8').catch(() => null)
      const diskMetadata = diskRaw == null ? null : this.parseMetadata(diskRaw)
      diskMetadataDrifted = !diskMetadata || JSON.stringify(diskMetadata) !== metadataBefore
    }
    let raw = await readFile(state.eventsPath).catch(() => Buffer.alloc(0))
    if (raw.length && raw[raw.length - 1] !== 0x0a) {
      const lastNewline = raw.lastIndexOf(0x0a)
      const keep = lastNewline < 0 ? 0 : lastNewline + 1
      await truncate(state.eventsPath, keep).catch(() => {})
      raw = raw.subarray(0, keep)
    }
    const lines = raw.toString('utf8').split('\n').filter(Boolean)
    const valid: PersistedLine[] = []
    let invalidInSegment = false
    for (const line of lines) {
      try {
        const event = parseHistoryEvent(JSON.parse(line) as unknown)
        if (event) valid.push({ event, raw: line })
        else {
          invalidInSegment = true
          this.invalidCount += 1
        }
      } catch {
        invalidInSegment = true
        this.invalidCount += 1
      }
    }
    if (invalidInSegment) {
      const body = valid.length ? `${valid.map((item) => item.raw).join('\n')}\n` : ''
      await writeFile(state.eventsPath, body, { encoding: 'utf8', mode: 0o600 })
    }
    state.eventIds = new Set(valid.map((item) => item.event.id))
    const meaningfulEventCount = valid.filter((item) => isMeaningfulHistoryEvent(item.event)).length
    state.metadata.eventCount = valid.length
    state.metadata.meaningfulEventCount = meaningfulEventCount
    state.metadata.retentionExpiresAt = segmentRetentionExpiresAt(Date.parse(state.metadata.bucketEnd))
    state.metadata.updatedAt = state.metadata.updatedAt || isoNow(this.now)
    if (forcePersist || diskMetadataDrifted || metadataBefore !== JSON.stringify(state.metadata))
      await this.persistMetadata(state)
  }

  private async loadSegment(metadata: HistorySegmentMetadata): Promise<SegmentState | null> {
    const dir = join(this.rootDir, SEGMENT_DIR, segmentFolder(metadata.bucketStart))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    const eventsPath = join(dir, 'events.jsonl')
    const metadataPath = join(dir, 'metadata.json')
    const storedRaw = await readFile(metadataPath, 'utf8').catch(() => null)
    const stored = storedRaw == null ? null : this.parseMetadata(storedRaw)
    const eventsRaw = await readFile(eventsPath).catch(() => null)
    if (storedRaw == null && eventsRaw == null) return null
    const indexMetadata = this.index.get(metadata.id) ?? metadata
    const compatibleDiskMetadata =
      stored &&
      stored.id === metadata.id &&
      stored.bucketStart === metadata.bucketStart &&
      stored.bucketEnd === metadata.bucketEnd
        ? stored
        : null
    if (stored && !compatibleDiskMetadata) return null
    const source =
      compatibleDiskMetadata && Date.parse(compatibleDiskMetadata.updatedAt) > Date.parse(indexMetadata.updatedAt)
        ? compatibleDiskMetadata
        : indexMetadata
    // SQLite and the JSONL sidecar can advance independently during a crash.
    // Keep the larger suppressed count because suppressed events have no JSONL row.
    const mergedMetadata: HistorySegmentMetadata = {
      ...source,
      eventsPath: relative(this.rootDir, eventsPath),
      suppressedEventCount: Math.max(
        indexMetadata.suppressedEventCount,
        compatibleDiskMetadata?.suppressedEventCount ?? 0
      )
    }
    const state: SegmentState = {
      metadata: mergedMetadata,
      metadataPath,
      eventsPath,
      eventIds: new Set()
    }
    await this.reconcileSegment(state)
    return state
  }

  private async writeMetadata(path: string, metadata: HistorySegmentMetadata): Promise<void> {
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  }

  private async readEvents(state: SegmentState): Promise<PersistedLine[]> {
    await this.reconcileSegment(state, false)
    const raw = await readFile(state.eventsPath, 'utf8').catch(() => '')
    const result: PersistedLine[] = []
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const event = parseHistoryEvent(JSON.parse(line) as unknown)
        if (event) result.push({ event, raw: line })
      } catch {
        // reconcileSegment already accounted for malformed lines.
      }
    }
    return result
  }

  private async cleanupSegment(metadata: HistorySegmentMetadata, cutoffMs: number, nowMs: number): Promise<void> {
    const state = this.metadataCache.get(metadata.id) ?? (await this.loadSegment(metadata))
    if (!state) {
      this.index.remove(metadata.id)
      return
    }
    const events = await this.readEvents(state)
    const retained = events.filter((item) => isHistoryEventRetained(item.event, nowMs))
    if (!retained.length && isSegmentExpired(Date.parse(metadata.bucketEnd), nowMs)) {
      const dir = join(this.segmentsDir, segmentFolder(metadata.bucketStart))
      await rm(dir, { recursive: true, force: true })
      this.index.remove(metadata.id)
      this.metadataCache.delete(metadata.id)
      if (this.currentSegmentId === metadata.id) this.currentSegmentId = null
      return
    }
    if (retained.length !== events.length) {
      const body = retained.length ? `${retained.map((item) => item.raw).join('\n')}\n` : ''
      await writeFile(state.eventsPath, body, { encoding: 'utf8', mode: 0o600 })
      state.eventIds = new Set(retained.map((item) => item.event.id))
      state.metadata.eventCount = retained.length
      state.metadata.meaningfulEventCount = retained.filter((item) => isMeaningfulHistoryEvent(item.event)).length
      state.metadata.updatedAt = new Date(nowMs).toISOString()
      state.metadata.retentionExpiresAt = segmentRetentionExpiresAt(Date.parse(state.metadata.bucketEnd))
      await this.persistMetadata(state)
    }
    if (Date.parse(metadata.bucketEnd) <= cutoffMs && !retained.length) {
      this.index.remove(metadata.id)
      this.metadataCache.delete(metadata.id)
      if (this.currentSegmentId === metadata.id) this.currentSegmentId = null
    }
  }

  private fail(error: unknown): void {
    this.state = 'degraded'
    this.lastError = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
  }
}
