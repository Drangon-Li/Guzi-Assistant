// legacy 工作记录：OCR 便车/Accessibility 语义归类两条路径的节流、落库与提示词。
// History v2 的工作记录由摘要独立派生（history/service.ts），不经过这里。
import {
  addWorkRecord,
  getSettings,
  listFocusTaskCandidates,
  listKnownAppNames,
  localDateTimeAt
} from './db'
import { isAppNameTask, isGenericFocusTask, normalizeTaskKey, normalizeTaskLabel } from '@shared/work-report'
import {
  ACTIVITY_SUMMARY_RULES,
  buildSemanticWorkHint,
  normalizeActivitySummary,
  parseSemanticWorkResults,
  semanticEvidenceKey
} from '@shared/semantic-work'
import type { OcrTriggerReason } from '@shared/hybrid-history'
import { cloudReady, parseToItemsRaw } from './parser'
import { setWorkClassificationStatus, type AccessibilityWorkContext } from './activity-tracker'
import { historyDerivedWorkActive } from './history/service.ts'
import { debugEvent } from './windows'

export function legacyWorkSummaryHint(): string {
  return historyDerivedWorkActive() ? '' : lastWorkRecordContent
}

// 工作记录搭同一次识别调用的便车：让模型在 items 之外多回 work_summary + focus_task 两个顶层字段。
// 措辞上三道防偏置（用户实测踩坑：示例里的真实任务名 + 「优先复用已知任务」会让模型把
// 不相干的活动全吸进同一个标签，一错错一下午）：
// ① 示例不用用户的真实任务名 ② 复用已知任务须屏幕内容明确对应 ③ 描述只依据屏幕可见内容
export function workSummaryHint(prevSummary: string, taskCandidates: string[]): string {
  const cand = taskCandidates.length
    ? `已知任务列表：${taskCandidates.join('、')}。若屏幕内容与某个已知任务主题相同、或是同一事项的延续（即使措辞不完全一样），必须原样复用该任务名，不要另起近义新名（例如都叫「论文研读与标注」，不要新造「论文2505.18966阅读」）；确实对不上才按屏幕内容起稳定的新名，不要为了复用而硬套。`
    : ''
  const base =
    '另外，在返回的 JSON 中额外加两个顶层字段：' +
    '① "work_summary"：一句不超过 40 字的中文，客观描述屏幕上正在进行的**工作/学习活动**。' +
    ACTIVITY_SUMMARY_RULES +
    '只依据屏幕可见内容描述，不要凭任务列表或历史记录猜测屏幕上看不到的项目名/用途；看不出具体属于哪个项目就写通用描述（如「编辑演示文稿」「整理文献」）。与工作学习无关或信息量极低的画面（随意浏览文件夹、刷聊天/社交消息、系统设置页、视频娱乐等）填 null，不要硬凑。' +
    `② "focus_task"：该活动归属的任务名——任务级、粗粒度、名称稳定。${cand}work_summary 为 null 时它也为 null。`
  // 传入上一条描述：同一活动持续中 → 原样返回同一句，让相邻记录能聚合成时段（避免措辞漂移拆成多段）
  return prevSummary
    ? `${base}\n若当前屏幕内容与上一条描述「${prevSummary}」本质上是同一活动，work_summary 请原样返回完全一致的字符串；若屏幕主题已明显变化，按当前内容重新描述，不要沿用旧描述。`
    : base
}

// 旧 OCR/手动路径的工作记录节流。History 派生路径不使用这组全局状态，避免跨 segment 串联。
const WORK_RECORD_MIN_GAP_MS = 60 * 1000
let lastWorkRecordAt = 0
let lastWorkRecordContent = ''
let lastWorkRecordTask: string | null = null
let lastWorkRecordApp: string | null = null
const OCR_FALLBACK_WORK_REASONS = new Set<OcrTriggerReason>([
  'manual',
  'observer_failure',
  'partial_high_value',
  'partial_retry',
  'empty_active',
  'hard_fallback_incomplete',
  'legacy_hard_fallback',
  'legacy_event'
])

/** startWatch/stopWatch 复位节流状态：停启之间不残留上一轮的去重基线。 */
export function resetWorkRecordThrottle(): void {
  lastWorkRecordAt = 0
  lastWorkRecordContent = ''
  lastWorkRecordTask = null
  lastWorkRecordApp = null
}

export function shouldPersistLegacyOcrWork(reason: OcrTriggerReason): boolean {
  return !historyDerivedWorkActive() || OCR_FALLBACK_WORK_REASONS.has(reason)
}

export function maybeAddWorkRecord(
  summary: string | null,
  task: string | null,
  frontApp: string | null,
  source: 'accessibility' | 'ocr',
  occurredAtMs?: number
): void {
  // 新路径只允许摘要回调落库；这里保留给旧 OCR/手动 fallback 和关闭开关后的回滚。
  if (source === 'accessibility' && historyDerivedWorkActive()) return
  const normalizedSummary = normalizeActivitySummary(summary, { appName: frontApp })
  if (!normalizedSummary) return
  // 泛化名（「随心输入」之类）对专注统计只有噪音，落库前直接丢弃任务标签；
  // 裸 App/产品名（「谷子助手」「微信」）同样不是任务
  const labeledTask = normalizeTaskLabel(task)
  const normalizedTask =
    isGenericFocusTask(labeledTask) || isAppNameTask(labeledTask, listKnownAppNames()) ? null : labeledTask
  const taskKey = normalizeTaskKey(normalizedTask ?? '')
  const appKey = normalizeTaskKey(frontApp ?? '')
  const now = Date.now()
  if (
    normalizedSummary === lastWorkRecordContent &&
    taskKey === normalizeTaskKey(lastWorkRecordTask ?? '') &&
    appKey === normalizeTaskKey(lastWorkRecordApp ?? '')
  ) return
  // Accessibility 已经按片段聚合并限制最多 8 个上下文；不同语义活动不能再被
  // OCR 路径遗留的全局 60 秒节流合并。OCR 仍保留旧节流，避免旧路径高频写入。
  if (source === 'ocr' && now - lastWorkRecordAt < WORK_RECORD_MIN_GAP_MS) return
  lastWorkRecordAt = now
  lastWorkRecordContent = normalizedSummary
  lastWorkRecordTask = normalizedTask
  lastWorkRecordApp = frontApp
  addWorkRecord({
    content: normalizedSummary,
    app: frontApp,
    task: normalizedTask,
    source,
    derivedBy: 'legacy',
    createdAt: occurredAtMs == null ? undefined : localDateTimeAt(occurredAtMs)
  })
  debugEvent('record', `工作记录：${normalizedSummary}${normalizedTask ? `（任务：${normalizedTask}）` : ''}`)
}

// ---------- Accessibility 语义工作归类队列 ----------

const SEMANTIC_WORK_MAX_CONTEXTS = 8
const semanticWorkContexts = new Map<string, Map<string, AccessibilityWorkContext>>()
const semanticWorkAttempted = new Set<string>()
const semanticWorkTimers = new Map<string, ReturnType<typeof setTimeout>>()
let semanticWorkAbort: AbortController | null = null
let semanticWorkQueue = Promise.resolve()

function semanticWorkKey(context: AccessibilityWorkContext): string {
  return `${context.segmentId}|${semanticEvidenceKey(context)}`
}

function semanticWorkSegmentEndMs(segmentId: string): number {
  const start = Date.parse(segmentId.replace('activity-10m-', ''))
  return Number.isFinite(start) ? start + 10 * 60 * 1000 : Date.now() + 60_000
}

function enqueueSemanticWork(contexts: AccessibilityWorkContext[]): void {
  const unique = contexts.filter((context, index, all) => {
    const key = semanticWorkKey(context)
    return !semanticWorkAttempted.has(key) && all.findIndex((item) => semanticWorkKey(item) === key) === index
  })
  if (!unique.length) return
  unique.forEach((context) => semanticWorkAttempted.add(semanticWorkKey(context)))
  setWorkClassificationStatus({ status: 'pending', source: 'accessibility', detail: null })
  semanticWorkQueue = semanticWorkQueue
    .then(() => classifySemanticWork(unique))
    .catch((error) => {
      if (semanticWorkAbort?.signal.aborted) return
      setWorkClassificationStatus({
        status: 'error',
        source: 'accessibility',
        detail: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
        atMs: Date.now()
      })
      debugEvent('semantic-work', 'Accessibility 归类失败')
    })
}

export function scheduleSemanticWork(context: AccessibilityWorkContext): void {
  const segment = semanticWorkContexts.get(context.segmentId) ?? new Map<string, AccessibilityWorkContext>()
  const key = semanticEvidenceKey(context)
  if (!segment.has(key) && segment.size < SEMANTIC_WORK_MAX_CONTEXTS) segment.set(key, context)
  semanticWorkContexts.set(context.segmentId, segment)
  if (context.highValueEvent) {
    enqueueSemanticWork([context])
    return
  }
  if (semanticWorkTimers.has(context.segmentId)) return
  const delay = Math.max(250, semanticWorkSegmentEndMs(context.segmentId) - Date.now() + 250)
  semanticWorkTimers.set(
    context.segmentId,
    setTimeout(() => {
      semanticWorkTimers.delete(context.segmentId)
      const pending = [...(semanticWorkContexts.get(context.segmentId)?.values() ?? [])]
      enqueueSemanticWork(pending)
    }, delay)
  )
}

async function classifySemanticWork(contexts: AccessibilityWorkContext[]): Promise<void> {
  if (!contexts.length) return
  if (!getSettings().screenSenseWorkLog) return
  if (!cloudReady()) {
    setWorkClassificationStatus({
      status: 'unavailable',
      source: 'accessibility',
      detail: '解析服务未就绪',
      atMs: Date.now()
    })
    return
  }
  const controller = new AbortController()
  semanticWorkAbort = controller
  try {
    const evidence = contexts.map((context) => ({
      app: context.appName,
      bundle_id: context.bundleId,
      window_title: context.windowTitle,
      focused_role: context.focusedRole,
      safe_label: context.safeLabel,
      event_type: context.eventKind,
      semantic_score: context.semanticScore,
      evidence_source: 'Accessibility'
    }))
    const { raw } = await parseToItemsRaw({
      text: JSON.stringify({ evidence }),
      hint: buildSemanticWorkHint(legacyWorkSummaryHint() || null, listFocusTaskCandidates()),
      signal: controller.signal
    })
    const results = parseSemanticWorkResults(raw, contexts.length)
    let saved = 0
    results.forEach((result, index) => {
      const context = contexts[index]
      if (!context) return
      const workSummary = normalizeActivitySummary(result.workSummary, {
        appName: context.appName,
        windowTitle: context.windowTitle,
        safeLabel: context.safeLabel
      })
      if (workSummary && !historyDerivedWorkActive()) {
        maybeAddWorkRecord(
          workSummary,
          result.focusTask,
          context.appName,
          'accessibility',
          context.occurredAtMs
        )
        saved += 1
      }
    })
    setWorkClassificationStatus({
      status: 'ok',
      source: 'accessibility',
      detail: saved ? `已归类 ${saved} 条活动` : '模型未给出明确工作活动',
      atMs: Date.now(),
      increment: true
    })
    debugEvent('semantic-work', `Accessibility 归类完成：${saved}/${contexts.length}`)
  } finally {
    if (semanticWorkAbort === controller) semanticWorkAbort = null
  }
}

export function stopSemanticWorkClassifier(): void {
  for (const timer of semanticWorkTimers.values()) clearTimeout(timer)
  semanticWorkTimers.clear()
  semanticWorkContexts.clear()
  semanticWorkAttempted.clear()
  semanticWorkAbort?.abort()
  semanticWorkAbort = null
  semanticWorkQueue = Promise.resolve()
  setWorkClassificationStatus({ status: 'idle', source: null, detail: null })
}
