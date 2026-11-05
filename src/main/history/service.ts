// History v2 生命周期：store/summarizer 启停、mutation barrier、查询服务与状态快照。
// 从 screenwatch.ts 迁出——事件采集由 activity-tracker/collector 负责，这里只管存储与派生。
import { join } from 'path'
import { app } from 'electron'
import { isExitPreparing } from '../content-lifecycle'
import {
  getHistorySegmentIndex,
  getHistorySummaryIndex,
  getSettings,
  listFocusTaskCandidates,
  listKnownAppNames
} from '../db'
import { getDb, listActivityIntervals, removeTimelineWorkRecords, upsertTimelineWorkRecord, addOcrEvidence, listOcrEvidence } from '../db'
import { getSession } from '../session'
import { broadcast, debugEvent } from '../windows'
import { configureHistoryHealthProvider, clearActivityHistoryEvidence } from '../activity-tracker'
import { privacyForContext } from '../privacy.ts'
import type { HistoryEvent } from './event-schema.ts'
import { HistorySegmentStore } from './event-store.ts'
import { HistorySummarizer, runHistorySummaryAfterStoreStart, type SummaryRunResult } from './summarizer.ts'
import { deriveTimelineWorkRecords } from './work-derivation.ts'
import { configureActivityHistoryAllowed, resetUsageTimelineBoundary } from '../usage-sampler.ts'
import { deleteActivityHistoryRange } from '../db/activity-retention.ts'
import { HistoryQueryService } from './query-service.ts'
import type { ActivityEvent } from '@shared/activity-events'
import type { HistoryStoreHealth, OcrEvidenceRecord } from '@shared/types'
import {
  emptyHistoryStoreHealth,
  type HistoryDeleteResult,
  type HistoryStatus,
  type HistoryQueryOptions,
  type HistorySearchOptions
} from '@shared/history'

let historyStore: HistorySegmentStore | null = null
let historyCleanupTimer: ReturnType<typeof setInterval> | null = null
let historySummaryTimer: ReturnType<typeof setInterval> | null = null
let historySummarizer: HistorySummarizer | null = null
let historyCloseTail: Promise<void> = Promise.resolve()
let historyMutationTail: Promise<void> = Promise.resolve()
let historyMutationPending = 0
let historyMutationEpoch = 0
let historyPaused = false
let historyQueryService: HistoryQueryService | null = null

configureActivityHistoryAllowed(() => !isExitPreparing() && !historyPaused && getSettings().historyV2Enabled)

/** collector 的 History 事件落盘回调：暂停时丢弃，否则写入当前 store 单例。 */
export function appendHistoryEventIfRunning(event: ActivityEvent): void {
  if (isExitPreparing() || historyPaused || historyMutationPending > 0 || !getSettings().historyV2Enabled) return
  // Resolve the current singleton at callback time. A pause/resume can
  // replace the store while the collector itself remains running.
  const decision = privacyForContext({
    name: event.appName ?? '', bundleId: event.bundleId ?? '', windowTitle: event.windowTitle ?? '',
    urlHost: event.urlHost, focusedRole: event.focusedRole ?? undefined,
    focusedSubrole: event.focusedSubrole ?? undefined, targetRole: event.targetRole ?? undefined,
    targetSubrole: event.targetSubrole ?? undefined, secureInput: event.secureInput
  }, true)
  historyStore?.append(decision.suppressed ? { ...event, ...decision } : event)
}

function historyEventAllowed(event: HistoryEvent): boolean {
  return !event.suppressed && event.privacy_state === 'normal' && !privacyForContext({
    name: event.app_name ?? '', bundleId: event.bundle_id ?? '', windowTitle: event.window_title ?? '',
    urlHost: event.url_host, targetRole: event.target_role ?? undefined, secureInput: event.secure_input
  }, true).suppressed
}

function historyPolicyKey(): string {
  const s = getSettings()
  return JSON.stringify([historyPaused, s.historyV2Enabled, s.screenSenseExcludedApps,
    s.historyExcludedApps.map((item) => item.bundleId), s.historyIncludedHosts, s.historyExcludedHosts])
}

export function isHistoryPaused(): boolean { return historyPaused }

export function getHistoryContentEpoch(): number { return historyMutationEpoch }

export function historyContentAllowed(context: Parameters<typeof privacyForContext>[0], epoch = historyMutationEpoch): boolean {
  return epoch === historyMutationEpoch && historyMutationPending === 0 && !historyPaused &&
    getSettings().historyV2Enabled && !privacyForContext(context, true).suppressed
}

export function invalidateHistoryContent(): void {
  historyMutationEpoch += 1
  resetUsageTimelineBoundary('privacy_changed')
  void historySummarizer?.invalidateAndWait()
}

export function appendOcrEvidenceIfAllowed(evidence: OcrEvidenceRecord): void {
  if (!historyContentAllowed({ name: evidence.appName ?? '', bundleId: evidence.bundleId ?? '',
    windowTitle: evidence.windowTitle ?? '', urlHost: evidence.urlHost })) return
  addOcrEvidence(evidence)
}

function ocrEventsForRange(fromMs: number, toMs: number): HistoryEvent[] {
  const intervals = listActivityIntervals(fromMs, toMs, { historyOnly: true })
  return listOcrEvidence(24, { fromMs, toMs }).flatMap((evidence) => {
    const at = Date.parse(evidence.occurredAt)
    if (!intervals.some((interval) => interval.appName === evidence.appName &&
      interval.startMs <= at && at < interval.endMs)) return []
    return [{ id: `ocr-${evidence.id}`, occurred_at: evidence.occurredAt, kind: 'screen_changed' as const,
      source: 'fallback' as const, app_name: evidence.appName, bundle_id: evidence.bundleId,
      window_title: evidence.windowTitle, url_host: evidence.urlHost ?? null, target_role: null,
      target_label: evidence.redactedText, command: null, modifiers: [], input_length: null,
      secure_input: false, privacy_state: 'normal' as const, suppressed: false }]
  })
}

function ensureHistoryStore(): HistorySegmentStore {
  if (!historyStore) {
    historyStore = new HistorySegmentStore({
      rootDir: join(app.getPath('userData'), 'history-v2'),
      index: getHistorySegmentIndex(),
      startAfter: historyCloseTail
    })
  }
  return historyStore
}


function historyStatusSnapshot(): HistoryStatus {
  const settings = getSettings()
  let health = historyStore?.health() ?? emptyHistoryStoreHealth({
    enabled: settings.historyV2Enabled,
    state: settings.historyV2Enabled ? (historyPaused ? 'stopped' : 'starting') : 'disabled'
  })
  let tenMinute = 0
  let sixHour = 0
  let retentionExpiresAt: string | null = null
  if (settings.historyV2Enabled) {
    try {
      const segmentRows = getHistorySegmentIndex().list()
      retentionExpiresAt = segmentRows
        .map((row) => row.retentionExpiresAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null
      tenMinute = getHistorySummaryIndex().count('10m')
      sixHour = getHistorySummaryIndex().count('6h')
    } catch {
      // IPC/MCP status remains readable while the database is booting.
    }
  }
  health = { ...health, enabled: settings.historyV2Enabled && health.enabled }
  return {
    enabled: settings.historyV2Enabled,
    paused: historyPaused,
    health,
    retentionExpiresAt,
    summaryCounts: { tenMinute, sixHour }
  }
}

function notifyAutomaticHistorySummary(result: SummaryRunResult): void {
  if (
    result.tenMinuteChanged <= 0 &&
    result.sixHourChanged <= 0 &&
    result.summariesPruned <= 0 &&
    result.modelSuccesses <= 0 &&
    result.modelFailures <= 0
  )
    return
  broadcast('guzi-assistant:history-updated')
}

async function historyStoreForQuery(allowPaused = false, allowDisabled = false): Promise<HistorySegmentStore | null> {
  const enabled = getSettings().historyV2Enabled
  if (!allowDisabled && !enabled) return null
  if (historyPaused && !allowPaused) return null
  try {
    const store = ensureHistoryStore()
    await store.start()
    configureHistoryHealthProvider(() => store.health())
    return store
  } catch (error) {
    debugEvent('error', `History 查询初始化失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function historySummaryOnlineEnabled(): boolean {
  try {
    const session = getSession()
    const settings = getSettings()
    return Boolean((session.functionsBase && session.token) || (settings.apiBase && settings.apiKey))
  } catch {
    return false
  }
}

function ensureHistorySummarizer(store: HistorySegmentStore): HistorySummarizer {
  if (!historySummarizer) {
    historySummarizer = new HistorySummarizer({
      store,
      summaryIndex: getHistorySummaryIndex(),
      onlineEnabled: historySummaryOnlineEnabled,
      eventAllowed: historyEventAllowed,
      supplementalEvents: ocrEventsForRange,
      policyKey: historyPolicyKey,
      focusTaskCandidates: listFocusTaskCandidates,
      // 工作记录的唯一来源：每个 10 分钟摘要按当段活动区间切成记录，整段覆盖写入（幂等）
      onTenMinuteSummary: (document, sourceHash) => {
        if (historyMutationPending > 0 || !getSettings().screenSenseWorkLog) return
        const segmentId = document.sourceSegmentId ?? document.sourceSegmentIds[0] ?? document.id
        try {
          const rows = deriveTimelineWorkRecords(document, sourceHash,
            listActivityIntervals(Date.parse(document.bucketStart), Date.parse(document.bucketEnd), { historyOnly: true }),
            listKnownAppNames())
          getDb().transaction(() => {
            removeTimelineWorkRecords(segmentId)
            for (const row of rows) upsertTimelineWorkRecord(row)
          })()
        } catch (error) {
          debugEvent('error', `History 工作记录派生失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
  }
  return historySummarizer
}

function historySummaryRunEmpty() {
  return {
    tenMinuteSummaries: 0,
    sixHourSummaries: 0,
    tenMinuteChanged: 0,
    sixHourChanged: 0,
    summariesPruned: 0,
    modelSuccesses: 0,
    modelFailures: 0
  }
}

function summaryOverlapsRange(record: { bucketStart: string; bucketEnd: string }, fromMs: number, toMs: number): boolean {
  const start = Date.parse(record.bucketStart)
  const end = Date.parse(record.bucketEnd)
  return Number.isFinite(start) && Number.isFinite(end) && end > fromMs && start < toMs
}

function serializeHistoryMutation<T>(job: () => Promise<T>): Promise<T> {
  // Raise the barrier synchronously so a timer/manual summary cannot start
  // between the destructive request and its position in the mutation queue.
  historyMutationPending += 1
  historyMutationEpoch += 1
  const run = historyMutationTail.then(async () => {
    await historyCloseTail.catch(() => {})
    await historySummarizer?.invalidateAndWait()
    return job()
  })
  historyMutationTail = run
    .then(() => undefined, () => undefined)
    .finally(() => {
      historyMutationPending = Math.max(0, historyMutationPending - 1)
    })
  return run
}

/** Keep summary timers out while a legacy wipe finishes its SQLite cleanup. */
export function acquireHistoryMutationBarrier(): () => void {
  historyMutationPending += 1
  historyMutationEpoch += 1
  let released = false
  return () => {
    if (released) return
    released = true
    historyMutationPending = Math.max(0, historyMutationPending - 1)
  }
}

async function createTemporaryHistoryStore(): Promise<{ store: HistorySegmentStore; temporary: boolean }> {
  if (historyStore) {
    await historyStore.start()
    return { store: historyStore, temporary: false }
  }
  const store = new HistorySegmentStore({
    rootDir: join(app.getPath('userData'), 'history-v2'),
    index: getHistorySegmentIndex(),
    startAfter: historyCloseTail
  })
  historyStore = store
  try {
    await store.start()
    return { store, temporary: true }
  } catch (error) {
    if (historyStore === store) historyStore = null
    throw error
  }
}

async function deleteHistoryRangeInternal(fromMs: number, toMs: number): Promise<HistoryDeleteResult> {
  return serializeHistoryMutation(async () => {
    resetUsageTimelineBoundary('history_deleted')
    const summaryIndex = getHistorySummaryIndex()
    const summaryIds = summaryIndex.list()
      .filter((record) => summaryOverlapsRange(record, fromMs, toMs))
      .map((record) => record.id)
    const { store, temporary } = await createTemporaryHistoryStore()
    let deletedSegmentIds: string[] = []
    try {
      deletedSegmentIds = await store.deleteRange(fromMs, toMs)
    } finally {
      if (temporary) {
        if (historyStore === store) historyStore = null
        await store.close()
      }
    }
    for (const id of summaryIds) summaryIndex.remove(id)
    const workRecordIds = deleteActivityHistoryRange(fromMs, toMs)
    clearActivityHistoryEvidence(fromMs, toMs)
    return {
      range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      deletedSegmentIds,
      deletedSummaryIds: summaryIds,
      deletedWorkRecordIds: [...new Set(workRecordIds)]
    }
  })
}

async function clearHistoryInternal(): Promise<HistoryDeleteResult> {
  return serializeHistoryMutation(async () => {
    const toMs = Date.now() + 1
    const fromMs = toMs - 1 - 48 * 60 * 60 * 1000
    resetUsageTimelineBoundary('history_cleared')
    const summaryIndex = getHistorySummaryIndex()
    const summaryIds = summaryIndex.list().map((record) => record.id)
    const indexedSegmentIds = getHistorySegmentIndex().list().map((record) => record.id)
    const { store, temporary } = await createTemporaryHistoryStore()
    let deletedSegmentIds: string[] = []
    try {
      deletedSegmentIds = await store.clear()
    } finally {
      if (temporary) {
        if (historyStore === store) historyStore = null
        await store.close()
      }
    }
    for (const id of summaryIds) summaryIndex.remove(id)
    const workRecordIds = deleteActivityHistoryRange(fromMs, toMs)
    clearActivityHistoryEvidence(fromMs, toMs)
    return {
      range: null,
      deletedSegmentIds: [...new Set([...deletedSegmentIds, ...indexedSegmentIds])].sort(),
      deletedSummaryIds: summaryIds,
      deletedWorkRecordIds: [...new Set(workRecordIds)]
    }
  })
}

async function processHistorySummaries() {
  if (isExitPreparing() || historyMutationPending > 0 || !getSettings().historyV2Enabled || historyPaused)
    return historySummaryRunEmpty()
  const startEpoch = historyMutationEpoch
  const store = startHistoryPersistence()
  if (!store) return historySummaryRunEmpty()
  const result = await runHistorySummaryAfterStoreStart(
    store,
    () =>
      historyMutationPending === 0 &&
      historyMutationEpoch === startEpoch &&
      !historyPaused &&
      getSettings().historyV2Enabled &&
      historyStore === store,
    () => ensureHistorySummarizer(store).process()
  )
  return result ?? historySummaryRunEmpty()
}

function ensureHistoryQueryService(): HistoryQueryService {
  if (!historyQueryService) {
    historyQueryService = new HistoryQueryService({
      summaryIndex: getHistorySummaryIndex(),
      segmentIndex: getHistorySegmentIndex(),
      getStore: () => historyStoreForQuery(),
      getStatus: historyStatusSnapshot,
      summarize: processHistorySummaries,
      pause: pauseHistory,
      resume: resumeHistory,
      deleteRange: deleteHistoryRangeInternal,
      clear: clearHistoryInternal
    })
  }
  return historyQueryService
}

export function historyStatus(): HistoryStatus {
  return historyStatusSnapshot()
}

export function historyRecent(options: HistoryQueryOptions = {}) {
  return ensureHistoryQueryService().recent(options)
}

export function historySearch(options: HistorySearchOptions = {}) {
  return ensureHistoryQueryService().search(options)
}

export async function historySummarize(options: HistoryQueryOptions = {}) {
  const result = await ensureHistoryQueryService().summarize(options)
  broadcast('guzi-assistant:history-updated')
  return result
}

export async function pauseHistory(): Promise<HistoryStatus> {
  if (!getSettings().historyV2Enabled) return historyStatusSnapshot()
  historyPaused = true
  resetUsageTimelineBoundary('history_pause')
  historyMutationEpoch += 1
  await stopHistoryPersistence()
  broadcast('guzi-assistant:history-updated')
  return historyStatusSnapshot()
}

export async function resumeHistory(): Promise<HistoryStatus> {
  historyPaused = false
  resetUsageTimelineBoundary('history_resume')
  historyMutationEpoch += 1
  if (getSettings().historyV2Enabled) {
    const store = startHistoryPersistence()
    if (store) await store.start()
  }
  broadcast('guzi-assistant:history-updated')
  return historyStatusSnapshot()
}

export async function clearHistory() {
  const result = await ensureHistoryQueryService().clear()
  broadcast('guzi-assistant:history-updated')
  return result
}

export async function deleteHistoryRange(options: HistoryQueryOptions) {
  const result = await ensureHistoryQueryService().deleteRange(options)
  broadcast('guzi-assistant:history-updated')
  return result
}

export function stopHistoryPersistence(): Promise<void> {
  historyMutationEpoch += 1
  if (historyCleanupTimer) {
    clearInterval(historyCleanupTimer)
    historyCleanupTimer = null
  }
  if (historySummaryTimer) {
    clearInterval(historySummaryTimer)
    historySummaryTimer = null
  }
  configureHistoryHealthProvider(null)
  const store = historyStore
  historyStore = null
  const summarizer = historySummarizer
  historySummarizer = null
  const closeSummarizer = summarizer?.close() ?? Promise.resolve()
  if (!store) return historyCloseTail.then(() => closeSummarizer)

  // Every new store waits for this tail. This prevents a pause/resume or
  // settings toggle from racing the previous instance while it flushes.
  historyCloseTail = historyCloseTail
    .catch(() => {})
    .then(() => closeSummarizer)
    .then(() => store.close())
    .catch((error) => {
      debugEvent('error', `History store 关闭失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    })
  return historyCloseTail
}

export function startHistoryPersistence(): HistorySegmentStore | null {
  if (!getSettings().historyV2Enabled || historyPaused) {
    void stopHistoryPersistence()
    return null
  }
  try {
    const store = ensureHistoryStore()
    const summarizer = ensureHistorySummarizer(store)
    const startEpoch = historyMutationEpoch
    configureHistoryHealthProvider(() => store.health())
    void store
      .start()
      .then(() => store.cleanup())
      .then(() => {
        if (
          isExitPreparing() || historyMutationPending > 0 ||
          historyMutationEpoch !== startEpoch ||
          historyPaused ||
          !getSettings().historyV2Enabled ||
          historyStore !== store ||
          historySummarizer !== summarizer
        )
          return historySummaryRunEmpty()
        return summarizer.process()
      })
      .then((result) => {
        notifyAutomaticHistorySummary(result)
        return result
      })
      .catch((error) => {
        debugEvent('error', `History store 启动/摘要失败：${error instanceof Error ? error.message : String(error)}`)
      })
    if (!historyCleanupTimer) {
      const timerStore = store
      historyCleanupTimer = setInterval(() => {
        if (isExitPreparing() || historyStore !== timerStore) return
        void timerStore.cleanup().catch((error) => {
          debugEvent('error', `History store 清理失败：${error instanceof Error ? error.message : String(error)}`)
        })
      }, 10 * 60 * 1000)
      historyCleanupTimer.unref?.()
    }
    if (!historySummaryTimer) {
      const timerStore = store
      historySummaryTimer = setInterval(() => {
        if (isExitPreparing() || historyMutationPending > 0 || historyStore !== timerStore || historySummarizer !== summarizer) return
        void summarizer.process()
          .then((result) => notifyAutomaticHistorySummary(result))
          .catch((error) => {
            debugEvent('error', `History 摘要失败：${error instanceof Error ? error.message : String(error)}`)
          })
      }, 60 * 1000)
      historySummaryTimer.unref?.()
    }
    return store
  } catch (error) {
    configureHistoryHealthProvider(() => emptyHistoryStoreHealth({
      enabled: true,
      state: 'degraded',
      lastError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
    }))
    debugEvent('error', `History store 初始化失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function shutdownHistoryStore(): Promise<void> {
  await stopHistoryPersistence()
  await historyCloseTail
}

export async function flushHistoryStore(): Promise<void> {
  await historyMutationTail
  await historyCloseTail
  await historySummarizer?.invalidateAndWait()
  await historyStore?.flush()
}
