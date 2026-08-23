import { createHash } from 'node:crypto'
import { redactSensitive } from '../../shared/sensitive.ts'
import { sanitizeWindowTitle } from '../../shared/activity-events.ts'
import { isAppNameTask, isGenericFocusTask } from '../../shared/work-report.ts'
import type { HistoryDerivedWorkRecordInput } from '../../shared/types.ts'
import type { HistorySummaryDocument } from './summarizer.ts'

const MAX_CONTENT_LENGTH = 200
const MAX_TASK_LENGTH = 80

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const redacted = redactSensitive(value).text
  const normalized = sanitizeWindowTitle(redacted, max).replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, max) : null
}

function finiteIso(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return value
}

function taskFromDocument(document: HistorySummaryDocument, knownApps: readonly string[]): string | null {
  // 只信模型给出的 focus_task；本地摘要的 focus 文本（围绕「窗口标题」…）不能回收成任务名，
  // 否则窗口标题会被当成任务写进专注统计
  const candidate = clean(document.modelSupplement?.focusTask ?? document.focusTask, MAX_TASK_LENGTH)
  if (!candidate) return null
  const key = candidate.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
  const appKeys = new Set(document.apps.map((app) => app.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()))
  if (appKeys.has(key)) return null
  if (/^(处理当前内容|当前内容|未能确定|未知任务|无)$/i.test(candidate)) return null
  // 「随心输入」类泛化名对专注统计只有噪音，视为无任务
  if (isGenericFocusTask(candidate)) return null
  // 裸 App/产品名（「谷子助手」「微信」）不是任务：命中本段 App 或历史出现过的 App 名即丢弃
  if (isAppNameTask(candidate, knownApps)) return null
  return candidate
}

function summaryHash(sourceHash: string, document: HistorySummaryDocument): string {
  // The source hash gives event-level idempotency; the summary fields make a
  // later model supplement update the same segment record in place.
  return createHash('sha256')
    .update(
      JSON.stringify({
        sourceHash,
        id: document.id,
        summary: document.summary,
        focusTask: document.focusTask,
        focus: document.focus,
        progress: document.progress,
        outcome: document.outcome,
        taskClues: document.taskClues,
        apps: document.apps,
        startAt: document.startAt,
        endAt: document.endAt,
        confidence: document.confidence,
        evidenceCount: document.evidenceCount
      })
    )
    .digest('hex')
}

/** Convert one ready 10-minute summary into the durable work-record shape. */
export function deriveHistoryWorkRecord(
  document: HistorySummaryDocument,
  sourceHash: string,
  knownApps: readonly string[] = []
): HistoryDerivedWorkRecordInput | null {
  if (document.level !== '10m' || document.meaningfulEvidenceCount <= 0) return null

  const segmentId = document.sourceSegmentId ?? document.sourceSegmentIds[0] ?? document.id
  if (!segmentId) return null

  const startAt = finiteIso(document.startAt) ?? finiteIso(document.bucketStart)
  const endAt = finiteIso(document.endAt) ?? finiteIso(document.bucketEnd)
  if (!startAt || !endAt) return null

  const startMs = Date.parse(startAt)
  const endMs = Date.parse(endAt)
  const normalizedStart = startMs <= endMs ? startAt : endAt
  const normalizedEnd = startMs <= endMs ? endAt : startAt
  const content = clean(document.summary, MAX_CONTENT_LENGTH)
  if (!content) return null

  const task = taskFromDocument(document, knownApps)
  const app = clean(document.apps[0] ?? null, 80)

  return {
    segmentId,
    content,
    app,
    task,
    startAt: normalizedStart,
    endAt: normalizedEnd,
    confidence: Math.min(1, Math.max(0, Number(document.confidence) || 0)),
    evidenceCount: Math.max(0, Math.trunc(Number(document.evidenceCount) || 0)),
    summaryHash: summaryHash(sourceHash, document)
  }
}
