import { unlink } from 'fs/promises'
import { app, nativeImage, powerMonitor, systemPreferences } from 'electron'
import { join } from 'path'
import { captureScreenSilently, excerptOf, HINTS } from './capture'
import { shouldTodoScan, todoScanAppKind } from '@shared/todo-scan'
import { ocrImageDetailed } from './ocr'
import { parseToItemsRaw } from './parser'
import {
  addAppSwitch,
  addAppUsage,
  addDetection,
  addWorkRecord,
  createSource,
  createTask,
  deleteSourceRow,
  getDetection,
  getProfile,
  getSettings,
  getSource,
  listFocusTaskCandidates,
  listKnownAppNames,
  localDateTimeAt,
  setDetectionStatus,
  findDuplicateTitle,
  getHistorySegmentIndex,
  getHistorySummaryIndex,
  listActivitySegmentsSince,
  listWorkRecordsSince,
  upsertHistoryWorkRecord,
  removeHistoryWorkRecord,
  removeHistoryWorkRecords,
  addOcrEvidence,
  upsertActivitySegment
} from './db'
import { applyReportSchedule } from './report-scheduler'
import { dayKey, isAppNameTask, isGenericFocusTask, normalizeTaskKey, normalizeTaskLabel } from '@shared/work-report'
import { broadcast, debugEvent, debugIsOpen, showPreview, isPreviewVisible } from './windows'
import { applyExternalPetSay, isPetVisible, setPetScanning } from './pet/controller'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { getFrontmostContext } from './frontapp'
import { saveShotTempFromPng, finalizeShot, deleteShot, listShotIds, sweepTempShots } from './shotvault'
import { getSession } from './session'
import { redactSensitive } from '@shared/sensitive'
import { looksLikeChat, clusterChatSpeakers, formatChatTranscript, type TextBox } from '@shared/chat-layout'
import { expiredShotIds } from '@shared/shot-retention'
import { dhash, hamming, bgraToGray, textHash } from '@shared/phash'
import { parseFocusTask, parseWorkSummary, type AddedInfo, type ParsedItem } from '@shared/parsing'
import {
  ACTIVITY_SUMMARY_RULES,
  buildSemanticWorkHint,
  normalizeActivitySummary,
  parseSemanticWorkResults,
  semanticEvidenceKey,
  type SemanticWorkEvidence
} from '@shared/semantic-work'
import type { HistoryStoreHealth, LocalExtraction, ParseSummary, ScanResult, TaskStatus } from '@shared/types'
import {
  activityScanDecision,
  getScreenActivityStatus as getActivityRuntimeStatus,
  markActivityObserverFailure,
  markActivityObserverHealthy,
  markActivityScan,
  configureActivityHistoryPersistence,
  configureHistoryHealthProvider,
  configureSemanticWorkClassifier,
  getHybridSemanticState,
  markOcrFallback,
  recordFrontmostContext,
  recordOcrEvidence,
  recordScreenChange,
  resetActivityGate,
  setWorkClassificationStatus,
  startActivityCollector,
  stopActivityCollector,
  type ActivityScanReason,
  type AccessibilityWorkContext
} from './activity-tracker'
import { decideOcrTrigger, type OcrTriggerReason } from '@shared/hybrid-history'
import { ACTIVITY_RETENTION_MS } from '@shared/activity-events'
import { decideHistoryPrivacy } from './history/privacy-policy.ts'
import { HistorySegmentStore } from './history/event-store.ts'
import { HistorySummarizer, runHistorySummaryAfterStoreStart, type SummaryRunResult } from './history/summarizer.ts'
import { deriveHistoryWorkRecord } from './history/work-derivation.ts'
import { HistoryQueryService } from './history/query-service.ts'
import { buildRolloutComparison } from './history/rollout-comparison.ts'
import type { HistoryDeleteResult, HistoryStatus, HistoryQueryOptions, HistorySearchOptions } from '@shared/history'

function emptySummary(error: string | null): ParseSummary {
  return { sourceId: '', total: 0, related: 0, autoAdded: 0, duplicates: 0, error }
}

export interface DetectHit {
  extraction: LocalExtraction
  item: ParsedItem
}

/** 两个 History 开关独立回滚：派生路径只有在事件流和派生开关都开启时生效。 */
function historyDerivedWorkActive(): boolean {
  const settings = getSettings()
  return settings.historyV2Enabled && settings.historyDerivedWorkEnabled
}

function legacyWorkSummaryHint(): string {
  return historyDerivedWorkActive() ? '' : lastWorkRecordContent
}

// 工作记录搭同一次识别调用的便车：让模型在 items 之外多回 work_summary + focus_task 两个顶层字段。
// 措辞上三道防偏置（用户实测踩坑：示例里的真实任务名 + 「优先复用已知任务」会让模型把
// 不相干的活动全吸进同一个标签，一错错一下午）：
// ① 示例不用用户的真实任务名 ② 复用已知任务须屏幕内容明确对应 ③ 描述只依据屏幕可见内容
function workSummaryHint(prevSummary: string, taskCandidates: string[]): string {
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

const FG_X_CUT = 0.18 // 裁前景图：去左侧栏/会话列表
const FG_Y_TOP = 0.025 // 去顶部菜单栏

/** 裁前景截图(去左侧栏/菜单栏)成 JPEG dataURL（供 VLM 二次确认）；失败返回 null。 */
function cropForegroundDataUrl(png: string): string | null {
  try {
    const img = nativeImage.createFromPath(png)
    const { width, height } = img.getSize()
    if (!width || !height) return null
    const x = Math.round(width * FG_X_CUT)
    const y = Math.round(height * FG_Y_TOP)
    const cropped = img.crop({ x, y, width: width - x, height: height - y })
    const sized = cropped.getSize().width > 2000 ? cropped.resize({ width: 2000 }) : cropped
    return `data:image/jpeg;base64,${sized.toJPEG(72).toString('base64')}`
  } catch {
    return null
  }
}

/** 一个候选是否「值得花一次视觉确认」：解出了具体时间、且不是明确别人的事。 */
function isScheduleCandidate(h: DetectHit): boolean {
  return h.extraction.strong && h.item.belongs_to_user !== 'no'
}

interface DetectResult {
  hits: DetectHit[]
  /** 「在做什么」一句话（工作记录开关关/模型没给时为 null） */
  workSummary: string | null
  /** 任务级标签（专注时长归并用） */
  focusTask: string | null
  /** 是否经过视觉模型二次确认 */
  confirmed: boolean
}

/**
 * 二段式检测：① OCR 文字上云解析出全部候选（+顺带工作记录总结，只传文字）；
 * ② 若开启视觉确认且出现「值得确认」的日程候选，把当帧截图裁前景发视觉模型深度确认，
 *    以视觉结果为准（空=文字层假阳性，丢弃）。png 为 null（如手动无图路径）时跳过②。
 */
async function detectAll(
  text: string,
  wantWorkLog: boolean,
  png: string | null,
  wantVlmConfirm: boolean,
  signal?: AbortSignal
): Promise<DetectResult> {
  const hint = wantWorkLog
    ? `${HINTS.screen_scan}\n${workSummaryHint(legacyWorkSummaryHint(), listFocusTaskCandidates())}`
    : HINTS.screen_scan
  const { items, raw } = await parseToItemsRaw({ text, hint, signal })
  const workSummary = wantWorkLog ? parseWorkSummary(raw) : null
  const focusTask = wantWorkLog ? parseFocusTask(raw) : null
  let hits = items.map((it) => ({ extraction: parsedToExtraction(it), item: it }))

  if (wantVlmConfirm && png && hits.some(isScheduleCandidate)) {
    const imageDataUrl = cropForegroundDataUrl(png)
    if (imageDataUrl) {
      try {
        const t0 = Date.now()
        const { items: refined } = await parseToItemsRaw({
          imageDataUrl,
          hint: HINTS.screen_scan_confirm,
          signal
        })
        debugEvent('cloud', `视觉确认耗时 ${Date.now() - t0}ms：${refined.length} 项`)
        return {
          hits: refined.map((it) => ({ extraction: parsedToExtraction(it), item: it })),
          workSummary,
          focusTask,
          confirmed: true
        }
      } catch {
        // 视觉确认失败（网络/额度）→ 回退文字层候选，不阻断
      }
    }
  }
  return { hits, workSummary, focusTask, confirmed: false }
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

function shouldPersistLegacyOcrWork(reason: OcrTriggerReason): boolean {
  return !historyDerivedWorkActive() || OCR_FALLBACK_WORK_REASONS.has(reason)
}

function maybeAddWorkRecord(
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

function scheduleSemanticWork(context: AccessibilityWorkContext): void {
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

function stopSemanticWorkClassifier(): void {
  for (const timer of semanticWorkTimers.values()) clearTimeout(timer)
  semanticWorkTimers.clear()
  semanticWorkContexts.clear()
  semanticWorkAttempted.clear()
  semanticWorkAbort?.abort()
  semanticWorkAbort = null
  semanticWorkQueue = Promise.resolve()
  setWorkClassificationStatus({ status: 'idle', source: null, detail: null })
}

/** 云端 ParsedItem → LocalExtraction（供 addDetection / 卡片显示）。 */
export function parsedToExtraction(it: ParsedItem): LocalExtraction {
  const iso = it.due_time ?? it.start_time
  return {
    title: it.title,
    isoTime: iso,
    deadline: !!it.due_time,
    belongsToUser: it.belongs_to_user,
    hits: [],
    confidence: it.confidence,
    strong: !!iso
  }
}

// ---------- 检测卡：一条走单卡，多条走批量清单卡 ----------
// 早期是逐张弹、逐张确认；一屏识别出 5 条要点 5 次，实测很烦，改成一张卡列全部、勾选后一次入库。
interface DetectedCard {
  suggestion: Record<string, unknown> // localSuggestion 载荷（卡显示 + 接受）
  detectionId: string
}

/** 把云端候选记进「记忆」历史，并挑出该弹卡的那些。屏幕感知与剪贴板自动捕获共用。
 *  onNewDetection 供屏幕路径存证据图；剪贴板路径没有截图，不传即可。 */
export function buildDetectionCards(input: {
  hits: DetectHit[]
  sourceText: string
  app: string | null
  popup: boolean
  onNewDetection?: () => void
}): DetectedCard[] {
  // 清单场景：一次识别出多条且其中至少一条解出了具体时间 → 这份列表不是噪声，整份都值得展示
  // （无时间的条目照样列出但不预勾）。单条候选仍然只有强信号才弹。
  const listMode = input.hits.length >= 2 && input.hits.some(({ extraction }) => extraction.strong)
  const cards: DetectedCard[] = []
  for (const { extraction, item } of input.hits) {
    debugEvent(
      'detect',
      `命中：「${extraction.title}」 ${extraction.isoTime ?? '无时间'} ${extraction.strong ? '[强]' : '[弱]'}`
    )
    // 被动留存 + 长期去重：跨状态按 标题+时间 去重；已记录过的内容不再重复抓取/弹窗
    const { detection, isNew } = addDetection({
      title: extraction.title,
      timeIso: extraction.isoTime,
      deadline: extraction.deadline,
      sourceText: input.sourceText,
      hits: extraction.hits,
      app: input.app
    })
    if (!isNew) {
      debugEvent('record', '已存在，不重复抓取')
      continue
    }
    debugEvent('record', '已记入「记忆」历史（新）')
    input.onNewDetection?.()
    if ((!extraction.strong && !listMode) || !input.popup) {
      debugEvent('popup', '不弹卡（弱信号或弹窗关），留在记忆历史')
      continue
    }
    cards.push({
      suggestion: { ...extraction, item, sourceText: input.sourceText, detectionId: detection.id },
      detectionId: detection.id
    })
  }
  return cards
}

export function showDetectedCards(cards: DetectedCard[]): void {
  if (!cards.length) return
  if (cards.length === 1) {
    showPreview({ localSuggestion: cards[0].suggestion })
    return
  }
  showPreview({ localBatch: { items: cards.map((card) => card.suggestion) } })
}

/** 由 OCR 框拼解析用文字；若像聊天界面（#54），前置「谁说的」转写作归属信号，保留全文。 */
function buildOcrText(boxes: TextBox[]): string {
  const text = boxes.map((b) => b.text).join('\n')
  if (!text) return ''
  if (looksLikeChat(boxes)) {
    const transcript = formatChatTranscript(clusterChatSpeakers(boxes))
    if (transcript) return `【聊天记录·谁说的】\n${transcript}\n\n【屏幕全文】\n${text}`
  }
  return text
}

/** 扫描一次当前屏幕：截图 → 本地 OCR → 云端解析 → 右下角弹建议卡 */
export async function scanOnce(): Promise<ScanResult> {
  // 桌宠可见时用 Siri 式光环表达"正在扫描"；否则退回加载卡（让用户知道在工作）
  const petGlow = isPetVisible()
  if (petGlow) setPetScanning(true)
  else showPreview({ busy: '正在扫描屏幕…' })
  debugEvent('tick', '手动扫描屏幕')
  try {
    const context = await getFrontmostContext()
    const privacy = context ? privacyForContext(context) : { suppressed: false, privacyState: 'normal' as const }
    if (privacy.suppressed) {
      const message = '当前窗口处于隐私抑制状态，未执行扫描'
      debugEvent('skip', message)
      showPreview({ error: message })
      return { status: 'empty', message }
    }
    markActivityScan('manual')
    markOcrFallback('manual')
    const png = await captureScreenSilently()
    if (!png) {
      const message = '截图失败，请检查屏幕录制权限'
      debugEvent('error', message)
      showPreview({ summary: emptySummary(message) }) // 红色错误卡，手动关闭
      return { status: 'error', message }
    }
    debugShot(png)

    const { screenSenseKeepShots, screenSenseWorkLog, screenSenseVlmConfirm } = getSettings()
    // png 保留到 OCR/确认/存证之后再删，故包一层 try/finally
    try {
      const boxes = await ocrImageDetailed(png)
      // 上云前脱敏：证件/卡号/密钥类的值打码（后续存历史/查重/上云统一用打码后文本）
      const red = redactSensitive(buildOcrText(boxes))
      const text = red.text
      recordOcrEvidence({
        eventId: null,
        occurredAtMs: Date.now(),
        appName: null,
        bundleId: null,
        windowTitle: null,
        semanticScore: 0,
        triggerReason: 'manual',
        redactionHits: red.hits,
        redactedText: text,
        privacyState: privacy.privacyState
      })
      debugEvent('ocr', text ? `OCR 完成：${text.length} 字` : 'OCR 未识别到文字')
      if (red.hits.length) debugEvent('ocr', `已脱敏：${red.hits.join('、')}`)
      if (!text) {
        showPreview({ error: '屏幕上没有识别到文字' }) // 灰色提示卡，3s 自动消失
        return { status: 'empty', message: '屏幕上没有识别到文字' }
      }
      debugEvent('ocr-text', `OCR 原文已处理：${text.length} 字（内容不写诊断日志）`)

      const t0 = Date.now()
      const { hits, workSummary, focusTask } = await detectAll(text, screenSenseWorkLog, png, screenSenseVlmConfirm)
      debugEvent('timing', `云端解析耗时 ${Date.now() - t0}ms`)
      maybeAddWorkRecord(workSummary, focusTask, null, 'ocr')
      if (!hits.length) {
        debugEvent('detect', '云端未发现明确待办')
        showPreview({ error: '未发现可添加的日程' }) // 灰色提示卡，3s 自动消失
        return { status: 'empty', message: '未发现可添加的日程' }
      }
      if (screenSenseKeepShots) saveShotTempFromPng(textHash(text), png) // 整帧一张证据图
      const cards: DetectedCard[] = hits.map(({ extraction, item }) => {
        debugEvent('detect', `命中：「${extraction.title}」 ${extraction.isoTime ?? '无时间'}`)
        const { detection } = addDetection({
          title: extraction.title,
          timeIso: extraction.isoTime,
          deadline: extraction.deadline,
          sourceText: text,
          hits: extraction.hits,
          app: null
        })
        return {
          suggestion: { ...extraction, item, sourceText: text, detectionId: detection.id },
          detectionId: detection.id
        }
      })
      showDetectedCards(cards) // 一条走单卡，多条汇成一张清单卡
      applyExternalPetSay(hits.length > 1 ? `发现 ${hits.length} 个日程~` : '发现一个日程~', 'waiting')
      return {
        status: 'suggested',
        message: hits.length > 1 ? `检测到 ${hits.length} 个可能的日程` : `检测到可能的日程：${hits[0].extraction.title}`
      }
    } finally {
      void unlink(png).catch(() => {}) // 原图用完即弃（检测/升级裁剪后）；只可能留加密缩略图
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    showPreview({ summary: emptySummary(message) })
    return { status: 'error', message }
  } finally {
    setPetScanning(false)
  }
}

/** 建议卡点"同意/修改"时入库：来源存 OCR 文字（非图），任务直接进日程 */
export function acceptSuggestion(payload: { item: ParsedItem; sourceText: string }): AddedInfo {
  const { item, sourceText } = payload
  // 聚焦证据(item.evidence)作来源内容；无证据时兜底整屏全文
  const evid = (item.evidence ?? []).map((s) => s.trim()).filter(Boolean)
  const evidenceText = evid.length ? evid.join('\n') : sourceText.slice(0, 1000)
  const source = createSource({
    type: 'screen_scan',
    excerpt: excerptOf(evidenceText),
    content: evidenceText.slice(0, 4000),
    filePath: null
  })
  const time = item.due_time ?? item.start_time
  // 模糊查重(同一事件不同表述) + VLM 语义查重(duplicate_of)双保险
  const dupOf = findDuplicateTitle(item.title, item.start_time, item.due_time) ?? item.duplicate_of
  if (dupOf) {
    deleteSourceRow(source.id) // 没有任务引用的来源不留库
    return { candidate: 0, title: item.title, time, duplicate: true, item }
  }
  const status: TaskStatus = item.due_time || item.start_time ? 'scheduled' : 'not_started'
  const task = createTask({
    sourceId: source.id,
    title: item.title,
    itemType: item.item_type,
    belongsToUser: item.belongs_to_user,
    belongingReason: item.belonging_reason,
    userRole: item.user_role,
    startTime: item.start_time,
    dueTime: item.due_time,
    location: item.location,
    priority: item.priority,
    confidence: item.confidence,
    suggestedAction: item.suggested_action,
    evidence: item.evidence,
    notes: item.notes,
    duplicateOf: item.duplicate_of,
    status,
    feedback: null
  })
  finalizeShot(textHash(sourceText), source.id) // 把捕获时存的临时加密缩略图落实到本来源（无则 no-op）
  broadcast('guzi-assistant:tasks-updated')
  return { candidate: 0, title: item.title, time, duplicate: false, taskId: task.id }
}

/** 检测历史条目 → ParsedItem（「记忆」页同意一条检测时重建入库载荷）。 */
export function buildLocalItem(e: LocalExtraction, reason = '屏幕识别'): ParsedItem {
  return {
    title: e.title,
    item_type: 'other',
    belongs_to_user: e.belongsToUser,
    belonging_reason: reason,
    user_role: 'unclear',
    start_time: e.deadline ? null : e.isoTime,
    due_time: e.deadline ? e.isoTime : null,
    location: null,
    priority: 'unknown',
    confidence: e.confidence,
    suggested_action: 'confirm',
    notes: [],
    evidence: [],
    duplicate_of: null
  }
}

/** 同意检测候选：直接入库；item 已含云端解析结果。带 detectionId 则标记历史为已加入。 */
export function acceptLocal(payload: {
  item: ParsedItem
  sourceText: string
  detectionId?: string
}): AddedInfo {
  const info = acceptSuggestion({ item: payload.item, sourceText: payload.sourceText })
  if (payload.detectionId) setDetectionStatus(payload.detectionId, 'accepted')
  return info
}

/** 批量同意清单卡上勾选的多条：逐条走 acceptLocal 的入库 + 查重路径，汇总结果。 */
export function acceptLocalBatch(payload: {
  entries: { item: ParsedItem; sourceText: string; detectionId?: string }[]
}): { added: number; duplicates: number; titles: string[] } {
  let added = 0
  let duplicates = 0
  const titles: string[] = []
  for (const entry of payload.entries) {
    const info = acceptLocal(entry)
    if (info.duplicate) duplicates += 1
    else {
      added += 1
      titles.push(info.title)
    }
  }
  return { added, duplicates, titles }
}

/** 从「记忆」历史里同意一条检测 → 入库并标记 accepted。 */
export function acceptDetection(id: string): AddedInfo | null {
  const d = getDetection(id)
  if (!d) return null
  const info = acceptSuggestion({
    item: buildLocalItem({
      title: d.title,
      isoTime: d.timeIso,
      deadline: d.deadline,
      belongsToUser: 'uncertain',
      hits: d.hits,
      confidence: 0.5,
      strong: !!d.timeIso
    }),
    sourceText: d.sourceText
  })
  setDetectionStatus(id, 'accepted')
  return info
}

/** 从「记忆」历史里忽略一条检测。 */
export function dismissDetection(id: string): void {
  setDetectionStatus(id, 'dismissed')
}

// ---------- 持续屏幕监控（事件门控 + 截图 fallback）----------
// 流水线：前台 App/窗口变化或硬兜底 → pHash → OCR → 文本冷却 → 云端解析 → 建议卡。
// pHash 算法与参数沿用 volcengine/MineContext（imagehash.dhash hash_size=8 + 异或 popcount 汉明距离；
// capture_interval 默认 5s、similarity_hash_threshold 默认 2），其为 Python+imagehash，此处用 TS 等价落地（见 @shared/phash）。

const PHASH_THRESHOLD = 2 // 汉明距离 ≤ 此值视为"屏幕没变" → 跳过 OCR/解析（MineContext 实测默认）
const COOLDOWN_MS = 10 * 60 * 1000 // 同一内容命中后冷却，避免反复弹卡
const IDLE_SKIP_SEC = 60 // 键鼠闲置超此秒数视为人不在电脑前，整轮跳过（不截图/不统计/不上云）

let watchTimer: ReturnType<typeof setInterval> | null = null
let watchPaused = false
let ticking = false
let watchAbort: AbortController | null = null
let lastHash: bigint | null = null
let lastTextHash = ''
let lastTodoScanAtMs: number | null = null // 待办识别通道的独立节流（与全局 OCR 冷却分开计）
let lastDebugApp: string | null | undefined = undefined // 调试日志：仅前台 App 变化时记一次，避免刷屏
let lastSwitchApp: string | null = null // 切换事件：上一次采样的前台应用（own-app/idle 轮不更新）
// 订阅到期/额度用尽的云端退避：期间保留本地采样（时长/切换不花钱），跳过截图/OCR/上云；
// 通知只发一次，解析恢复成功后复位。曾因每 1-2s 白打一次 402 刷爆日志。
const CLOUD_PAUSE_MS = 10 * 60_000
let cloudPauseUntil = 0
let cloudPauseNotified = false
let previewBlockLogged = false // 调试日志：预览卡占用导致跳过只记一次，卡关掉后重置
let cloudBlockLogged = false // 调试日志：解析服务未就绪导致跳过只记一次，恢复后重置
const cooldown = new Map<string, number>()
let trayRefresh: (() => void) | null = null

/** index.ts 注入：监控状态变化（开/停/暂停）时刷新托盘菜单 */
export function setTrayRefresh(fn: () => void): void {
  trayRefresh = fn
}
export function isWatchActive(): boolean {
  return watchTimer !== null
}
export function isWatchPaused(): boolean {
  return watchPaused
}

/** 用 Electron nativeImage 取 9×8 灰度像素算 dhash（等价 imagehash.dhash hash_size=8） */
async function pHashOfPng(pngPath: string): Promise<bigint> {
  const img = nativeImage.createFromPath(pngPath).resize({ width: 9, height: 8, quality: 'good' })
  const { width, height } = img.getSize()
  return dhash(bgraToGray(img.toBitmap(), width, height), width, height)
}

/** 调试用：把当前截图缩成小 JPEG dataURL 推给调试窗（仅窗开时，零开销）。 */
function debugShot(png: string): void {
  if (!debugIsOpen()) return
  try {
    const buf = nativeImage.createFromPath(png).resize({ width: 360 }).toJPEG(55)
    debugEvent('screenshot', '抓取到截图', { image: `data:image/jpeg;base64,${buf.toString('base64')}` })
  } catch {
    /* 调试用，失败忽略 */
  }
}

/** 是否谷子助手自己在前台：停在本应用页面时不该扫描自己的窗口（否则把已有日程当成新检测）。 */
function isOwnApp(frontApp: string | null): boolean {
  if (!frontApp) return false
  const f = frontApp.trim().toLowerCase()
  // 保留历史进程名：升级后仍要排除旧版本窗口，避免把自己的日程重新识别为新任务。
  return [
    app.getName(),
    'electron',
    'GuziAssistant',
    'Guzi Assistant',
    '谷子助手',
    'gooz',
    '纸壳助手',
    'eshell'
  ].some(
    (n) => n && f.includes(n.toLowerCase())
  )
}

function privacyForContext(context: {
  name: string
  bundleId: string
  windowTitle: string
  urlHost?: string | null
  focusedRole?: string
  focusedSubrole?: string
  targetRole?: string
  targetSubrole?: string
  secureInput?: boolean
}, historyOnly = false): {
  suppressed: boolean
  privacyState: 'normal' | 'private' | 'excluded' | 'own' | 'secure'
} {
  const settings = getSettings()
  const decision = decideHistoryPrivacy({
    appName: context.name,
    bundleId: context.bundleId,
    windowTitle: context.windowTitle,
    urlHost: historyOnly ? context.urlHost : undefined,
    focusedRole: context.focusedRole,
    focusedSubrole: context.focusedSubrole,
    targetRole: context.targetRole,
    targetSubrole: context.targetSubrole,
    secureInput: context.secureInput,
    ownAppNames: [
      app.getName(),
      'Electron',
      'GuziAssistant',
      'Guzi Assistant',
      '谷子助手',
      'Gooz',
      'EShell',
      '纸壳助手'
    ],
    excludedApps: settings.screenSenseExcludedApps,
    excludedBundleIds: historyOnly ? settings.historyExcludedApps.map((item) => item.bundleId) : [],
    excludedHosts: historyOnly ? settings.historyExcludedHosts : [],
    includedHosts: historyOnly ? settings.historyIncludedHosts : []
  })
  return { suppressed: !decision.persist, privacyState: decision.state }
}

/** 云端解析可用性：已登录（网关）或已配直连 API，且完成档案设置。未就绪时监控静默跳过，不白跑截图/OCR。 */
export function cloudReady(): boolean {
  const { functionsBase, token } = getSession()
  const { apiBase, apiKey } = getSettings()
  if (!((functionsBase && token) || (apiBase && apiKey))) return false
  return !!getProfile()
}

/** 一轮静默监控；全程不打扰用户，只有真发现待办才弹建议卡 */
async function watchTick(): Promise<void> {
  if (ticking || watchPaused) return
  if (isPreviewVisible()) {
    // 别覆盖用户正在看的卡；卡片一直开着会让监控看似"卡死"，调试面板里明确提示一次
    if (!previewBlockLogged) {
      debugEvent('skip', '预览卡显示中，监控暂停（关掉右下角卡片后自动恢复）')
      previewBlockLogged = true
    }
    return
  }
  previewBlockLogged = false
  ticking = true
  const controller = new AbortController()
  watchAbort = controller
  const signal = controller.signal
  let png: string | null = null
  try {
    // 解析服务未就绪（未登录且未配直连 API/无档案）→ 静默跳过，不白跑截图/OCR/云调用
    if (!cloudReady()) {
      if (!cloudBlockLogged) {
        debugEvent('skip', '解析服务未就绪（未登录或未完成档案），监控暂停')
        cloudBlockLogged = true
      }
      return
    }
    cloudBlockLogged = false
    if (signal.aborted) return
    if (powerMonitor.getSystemIdleTime() >= IDLE_SKIP_SEC) return // 人不在电脑前，静默跳过
    const {
      screenSenseKeepShots,
      screenSensePopup,
      screenSenseWorkLog,
      screenSenseVlmConfirm,
      screenSenseEventDriven,
      screenSenseFallbackIntervalSec,
      screenSenseHybridV2,
      todoScanEnabled,
      todoScanIntervalSec
    } = getSettings()
    // 自动采集必须先拿到前台上下文；失败时 fail-closed，不执行截图。
    const context = await getFrontmostContext()
    if (watchPaused) return
    if (signal.aborted) return
    if (!context?.name) {
      markActivityObserverFailure('无法读取前台应用上下文，已停止自动截图')
      debugEvent('skip', '前台上下文不可用，自动采集 fail-closed')
      return
    }
    const frontApp = context.name
    const appChanged = frontApp !== lastDebugApp
    lastDebugApp = frontApp
    if (appChanged) debugEvent('frontapp', `前台应用：${frontApp ?? '(未知)'}`)
    const privacy = privacyForContext(context)
    const { suppressed, privacyState } = privacy
    const excluded = privacyState === 'excluded'
    const ownApp = privacyState === 'own'
    const privateWindow = privacyState === 'private'
    recordFrontmostContext(context, {
      suppressed,
      observerHealthy: false,
      privacyState
    })
    if (excluded) {
      if (appChanged) debugEvent('skip', '在排除名单，跳过')
      return
    }
    if (ownApp) {
      if (appChanged) debugEvent('skip', '谷子助手自己在前台，跳过')
      return
    }
    if (privateWindow || privacyState === 'secure') {
      if (appChanged) debugEvent('skip', '浏览器私密窗口，跳过')
      return
    }
    if (Date.now() < cloudPauseUntil) return // 退避窗口内：采样已记完，不截图不上云

    const decision = activityScanDecision(
      screenSenseEventDriven,
      screenSenseFallbackIntervalSec
    )
    const gateEligible =
      decision.run || (screenSenseHybridV2 && decision.reason === 'observer_unavailable')
    if (!gateEligible) return
    const semanticState = getHybridSemanticState()
    const screenAllowed =
      process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted'
    // 待办识别独立通道：内容型 App 前台且到间隔时，语义完整也看一次正文。
    // 与 screenSensePopup 解耦——popup 关的语义是「只进记忆不弹卡」，识别照跑。
    const todoScanDue = shouldTodoScan({
      enabled: todoScanEnabled,
      appKind: todoScanAppKind(frontApp, context.bundleId),
      nowMs: Date.now(),
      lastTodoScanAtMs,
      intervalSec: todoScanIntervalSec
    })
    const trigger = decideOcrTrigger({
      hybridEnabled: screenSenseHybridV2,
      todoScanDue,
      semantic: semanticState.assessment,
      nowMs: Date.now(),
      active: powerMonitor.getSystemIdleTime() < IDLE_SKIP_SEC,
      screenAllowed,
      highValueEvent: semanticState.highValueEvent,
      consecutivePartialCount: semanticState.consecutivePartialCount,
      observerHealthy: semanticState.observerHealthy,
      observerFailureCount: semanticState.observerFailureCount,
      lastOcrAtMs: semanticState.lastOcrAtMs,
      lastOcrContextKey: semanticState.lastOcrContextKey,
      contextKey: semanticState.contextKey,
      hardFallback: decision.reason === 'hard_fallback'
    })
    if (!trigger.run) {
      markActivityScan('semantic_only')
      debugEvent(
        'semantic',
        screenSenseHybridV2
          ? `语义${semanticState.assessment.semanticLevel}（${semanticState.assessment.score}），不触发 OCR：${trigger.reason}`
          : `legacy 门控未触发 OCR：${trigger.reason}`
      )
      if (decision.reason === 'observer_unavailable')
        debugEvent('skip', '事件观察器不可用，已完成一次受限语义检查')
      return
    }
    markActivityScan(decision.reason === 'observer_unavailable' ? 'event' : (decision.reason as ActivityScanReason))
    const triggerReason = trigger.reason as OcrTriggerReason
    if (triggerReason === 'todo_scan') lastTodoScanAtMs = Date.now()
    markOcrFallback(triggerReason)
    debugEvent('ocr-trigger', `按需 OCR：${trigger.reason}（semantic=${semanticState.assessment.score}）`)

    png = await captureScreenSilently()
    if (signal.aborted) return
    if (!png) {
      debugEvent('error', '截图失败（检查屏幕录制权限）')
      return
    }
    const hash = await pHashOfPng(png)
    const distance = lastHash === null ? PHASH_THRESHOLD + 1 : hamming(hash, lastHash)
    if (lastHash !== null && distance <= PHASH_THRESHOLD) return // 屏幕没变 → 静默跳过
    lastHash = hash
    recordScreenChange(context)
    debugEvent('screenshot', '屏幕有变化，已截图')
    debugShot(png)

    debugEvent('ocr', '本地 OCR 识别中…')
    const boxes = await ocrImageDetailed(png)
    if (signal.aborted) return
    // 上云前脱敏：证件/卡号/密钥类的值打码（后续存历史/查重/上云统一用打码后文本）
    const red = redactSensitive(buildOcrText(boxes))
    const text = red.text
    recordOcrEvidence({
      eventId: null,
      occurredAtMs: Date.now(),
      appName: frontApp,
      bundleId: context.bundleId,
      windowTitle: context.windowTitle,
      semanticScore: semanticState.assessment.score,
      triggerReason,
      redactionHits: red.hits,
      redactedText: text,
      privacyState
    })
    if (!text) {
      debugEvent('ocr', 'OCR 未识别到文字')
      return
    }
    debugEvent('ocr', `OCR 完成：${text.length} 字`)
    if (red.hits.length) debugEvent('ocr', `已脱敏：${red.hits.join('、')}`)
    const th = textHash(text)
    if (th === lastTextHash) return // 文本没变 → 静默跳过
    lastTextHash = th

    // 内容冷却（同内容 10 分钟内不重复跑模型/弹卡）→ 放模型前，省推理
    const now = Date.now()
    for (const [k, exp] of cooldown) if (exp <= now) cooldown.delete(k) // 清理过期，避免 Map 无界增长
    const until = cooldown.get(th)
    if (until && until > now) {
      debugEvent('record', '同内容冷却中，跳过')
      return
    }
    cooldown.set(th, now + COOLDOWN_MS) // 命中或未命中都冷却，避免双屏来回切时反复跑模型

    // 云端解析 → 全部候选（多任务）+ 顺带的工作记录
    const { hits, workSummary, focusTask } = await detectAll(
      text,
      screenSenseWorkLog,
      png,
      screenSenseVlmConfirm,
      signal
    )
    if (signal.aborted) return
    cloudPauseNotified = false // 解析成功 → 下次再断流时重新提醒
    if (shouldPersistLegacyOcrWork(triggerReason))
      maybeAddWorkRecord(workSummary, focusTask, frontApp, 'ocr')
    if (!hits.length) {
      debugEvent('detect', '云端未发现明确待办')
      return
    }

    let savedShot = false
    const cards = buildDetectionCards({
      hits,
      sourceText: text,
      app: frontApp,
      popup: screenSensePopup,
      // 截图持久化（#52/#53）：趁 png 还在存整帧证据图（一张）
      onNewDetection: () => {
        if (screenSenseKeepShots && png && !savedShot) {
          saveShotTempFromPng(th, png)
          savedShot = true
        }
      }
    })
    if (!cards.length) return
    // 新鲜度门：仍在同一 App 才弹（切走了就只留历史）
    const freshContext = await getFrontmostContext()
    if (signal.aborted) return
    if (!freshContext || freshContext.name !== frontApp) {
      debugEvent('popup', '已切走 App，不弹')
      return
    }
    debugEvent('popup', cards.length > 1 ? `弹出清单卡：${cards.length} 条` : '弹出检测卡')
    showDetectedCards(cards)
    applyExternalPetSay(cards.length > 1 ? `发现 ${cards.length} 个日程~` : '发现一个日程~', 'waiting')
  } catch (e) {
    if (signal.aborted) return
    // 持续监控全程静默不打扰用户，但必须留诊断痕迹——
    // 曾因此完全静默：云端解析连续失败 7 小时（工作记录/检测全断）而日志无任何线索
    const msg = e instanceof Error ? e.message : String(e)
    debugEvent('error', `监控轮异常：${msg}`)
    // 计费类失败（订阅到期/试用结束/额度用尽/旧积分文案）→ 退避 + 只提醒一次
    if (/订阅|试用|额度|积分不足/.test(msg)) {
      cloudPauseUntil = Date.now() + CLOUD_PAUSE_MS
      if (!cloudPauseNotified) {
        cloudPauseNotified = true
        applyExternalPetSay(
          /额度/.test(msg) ? '今天的额度用完啦，明天继续～' : '订阅到期了，续订后我继续帮你记～',
          'waiting',
          { durationMs: 12_000 }
        )
      }
    }
  } finally {
    if (png) void unlink(png).catch(() => {})
    if (watchAbort === controller) watchAbort = null
    ticking = false
  }
}

// ---------- 前台应用采样（app_usage 时长 + app_switches 切换事件）----------
// 与监控轮解耦：只读前台 App 名（NSWorkspace，无需权限、不看屏幕内容、不花钱），
// 所以不受 ticking 守卫/检测卡/未登录/云端退避影响；托盘暂停仍生效——用户暂停即全部暂停。

const SAMPLE_SEC = 5
let sampleTimer: ReturnType<typeof setInterval> | null = null
let historyStore: HistorySegmentStore | null = null
let historyCleanupTimer: ReturnType<typeof setInterval> | null = null
let historySummaryTimer: ReturnType<typeof setInterval> | null = null
let historyLegacySyncTimer: ReturnType<typeof setInterval> | null = null
let historySummarizer: HistorySummarizer | null = null
let historyCloseTail: Promise<void> = Promise.resolve()
let historyMutationTail: Promise<void> = Promise.resolve()
let historyMutationPending = 0
let historyMutationEpoch = 0
let historyPaused = false
let historyQueryService: HistoryQueryService | null = null
let historyRolloutCache: { atMs: number; value: HistoryStatus['rolloutComparison'] } = { atMs: 0, value: null }
let sampling = false
let lastSampleAtMs = 0
let systemInactive = false

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

function historyHealthFallback(enabled: boolean, state: HistoryStoreHealth['state']): HistoryStoreHealth {
  return {
    enabled,
    state,
    currentSegmentId: null,
    queueLength: 0,
    droppedCount: 0,
    suppressedCount: 0,
    invalidCount: 0,
    segmentCount: 0,
    lastWriteAt: null,
    lastCleanupAt: null,
    lastError: null
  }
}

function historyStatusSnapshot(): HistoryStatus {
  const settings = getSettings()
  let health = historyStore?.health() ?? historyHealthFallback(
    settings.historyV2Enabled,
    settings.historyV2Enabled ? (historyPaused ? 'stopped' : 'starting') : 'disabled'
  )
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
    summaryCounts: { tenMinute, sixHour },
    rolloutComparison: historyRolloutComparisonSnapshot()
  }
}

function invalidateHistoryRolloutComparison(): void {
  historyRolloutCache = { atMs: 0, value: null }
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
  invalidateHistoryRolloutComparison()
  broadcast('guzi-assistant:history-updated')
}

/** Keep the legacy activity_segments baseline current while History runs alone. */
function syncLegacyHistorySegments(): void {
  const settings = getSettings()
  if (!settings.historyV2Enabled || historyPaused) return
  try {
    getActivityRuntimeStatus({
      eventDriven: settings.screenSenseEventDriven,
      hybridV2: settings.screenSenseHybridV2,
      running: isWatchActive() || !historyPaused,
      paused: watchPaused || historyPaused
    })
  } catch (error) {
    debugEvent('error', `History 旧链路双写失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function stopLegacyHistorySync(): void {
  if (!historyLegacySyncTimer) return
  clearInterval(historyLegacySyncTimer)
  historyLegacySyncTimer = null
}

function startLegacyHistorySync(): void {
  stopLegacyHistorySync()
  syncLegacyHistorySegments()
  historyLegacySyncTimer = setInterval(syncLegacyHistorySegments, 5_000)
  historyLegacySyncTimer.unref?.()
}

/** Build a bounded, aggregate-only comparison for the current 48-hour rollout window. */
function historyRolloutComparisonSnapshot(nowMs = Date.now()): HistoryStatus['rolloutComparison'] {
  if (!getSettings().historyV2Enabled) return null
  if (historyRolloutCache.value && nowMs - historyRolloutCache.atMs < 5_000) return historyRolloutCache.value
  const fromMs = nowMs - ACTIVITY_RETENTION_MS
  const fromIso = new Date(nowMs - ACTIVITY_RETENTION_MS).toISOString()
  const toIso = new Date(nowMs).toISOString()
  try {
    const comparison = buildRolloutComparison({
      nowMs,
      retentionMs: ACTIVITY_RETENTION_MS,
      legacySegments: listActivitySegmentsSince(fromIso, toIso),
      // Keep the comparison bounded before materializing aggregate inputs;
      // retention cleanup is best-effort and stale rows may survive a crash.
      historySegments: getHistorySegmentIndex().list().filter((row) => summaryOverlapsRange(row, fromMs, nowMs)),
      summaries: getHistorySummaryIndex().list().filter((row) => summaryOverlapsRange(row, fromMs, nowMs)),
      workRecords: listWorkRecordsSince(fromIso.slice(0, 10)).map((record) => ({
        id: record.id,
        derivedBy: record.derivedBy,
        segmentId: record.segmentId,
        app: record.app,
        task: record.task,
        content: record.content,
        startAt: record.startAt,
        endAt: record.endAt,
        summaryHash: record.summaryHash
      }))
    })
    historyRolloutCache = { atMs: nowMs, value: comparison }
    return comparison
  } catch (error) {
    debugEvent('error', `History 双写对比失败：${error instanceof Error ? error.message : String(error)}`)
    historyRolloutCache = { atMs: nowMs, value: null }
    return null
  }
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
      focusTaskCandidates: listFocusTaskCandidates,
      onTenMinuteSummary: (document, sourceHash) => {
        if (historyMutationPending > 0 || !historyDerivedWorkActive()) return
        const derived = deriveHistoryWorkRecord(document, sourceHash, listKnownAppNames())
        const segmentId = document.sourceSegmentId ?? document.sourceSegmentIds[0] ?? document.id
        try {
          if (derived) upsertHistoryWorkRecord(derived)
          else if (segmentId) removeHistoryWorkRecord(segmentId)
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
    const summaryIndex = getHistorySummaryIndex()
    const summariesBefore = summaryIndex.list()
    const summaryIds = summariesBefore
      .filter((record) => summaryOverlapsRange(record, fromMs, toMs))
      .map((record) => record.id)
    const segmentIdsFromSummaries = summariesBefore
      .filter((record) => summaryIds.includes(record.id))
      .flatMap((record) => record.sourceSegmentIds)
    // A 6-hour summary may overlap a narrow delete range while referencing
    // segments outside it. Only work records whose own segment intersects the
    // requested range are eligible for removal.
    const segmentIdsInRange = new Set(
      getHistorySegmentIndex()
        .list()
        .filter((record) => summaryOverlapsRange(record, fromMs, toMs))
        .map((record) => record.id)
    )
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
    const workRecordIds = removeHistoryWorkRecords([
      ...new Set([
        ...deletedSegmentIds,
        ...segmentIdsFromSummaries.filter((segmentId) => segmentIdsInRange.has(segmentId))
      ])
    ])
    return {
      range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      deletedSegmentIds,
      deletedSummaryIds: summaryIds,
      deletedWorkRecordIds: workRecordIds
    }
  })
}

async function clearHistoryInternal(): Promise<HistoryDeleteResult> {
  return serializeHistoryMutation(async () => {
    const summaryIndex = getHistorySummaryIndex()
    const summaries = summaryIndex.list()
    const summaryIds = summaries.map((record) => record.id)
    const summarySegmentIds = summaries.flatMap((record) => record.sourceSegmentIds)
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
    const workRecordIds = removeHistoryWorkRecords([...new Set([...deletedSegmentIds, ...indexedSegmentIds, ...summarySegmentIds])])
    return {
      range: null,
      deletedSegmentIds: [...new Set([...deletedSegmentIds, ...indexedSegmentIds])].sort(),
      deletedSummaryIds: summaryIds,
      deletedWorkRecordIds: workRecordIds
    }
  })
}

async function processHistorySummaries() {
  if (historyMutationPending > 0 || !getSettings().historyV2Enabled || historyPaused)
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
  invalidateHistoryRolloutComparison()
  broadcast('guzi-assistant:history-updated')
  return result
}

export async function pauseHistory(): Promise<HistoryStatus> {
  if (!getSettings().historyV2Enabled) return historyStatusSnapshot()
  historyPaused = true
  historyMutationEpoch += 1
  await stopHistoryPersistence()
  invalidateHistoryRolloutComparison()
  broadcast('guzi-assistant:history-updated')
  return historyStatusSnapshot()
}

export async function resumeHistory(): Promise<HistoryStatus> {
  historyPaused = false
  historyMutationEpoch += 1
  if (getSettings().historyV2Enabled) {
    const store = startHistoryPersistence()
    if (store) await store.start()
  }
  invalidateHistoryRolloutComparison()
  broadcast('guzi-assistant:history-updated')
  return historyStatusSnapshot()
}

export async function clearHistory() {
  const result = await ensureHistoryQueryService().clear()
  invalidateHistoryRolloutComparison()
  broadcast('guzi-assistant:history-updated')
  return result
}

export async function deleteHistoryRange(options: HistoryQueryOptions) {
  const result = await ensureHistoryQueryService().deleteRange(options)
  invalidateHistoryRolloutComparison()
  broadcast('guzi-assistant:history-updated')
  return result
}

function stopHistoryPersistence(): Promise<void> {
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
    })
  return historyCloseTail
}

function startHistoryPersistence(): HistorySegmentStore | null {
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
          historyMutationPending > 0 ||
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
        if (historyStore !== timerStore) return
        void timerStore.cleanup().catch((error) => {
          debugEvent('error', `History store 清理失败：${error instanceof Error ? error.message : String(error)}`)
        })
      }, 10 * 60 * 1000)
      historyCleanupTimer.unref?.()
    }
    if (!historySummaryTimer) {
      const timerStore = store
      historySummaryTimer = setInterval(() => {
        if (historyMutationPending > 0 || historyStore !== timerStore || historySummarizer !== summarizer) return
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
    configureHistoryHealthProvider(() => ({
      enabled: true,
      state: 'degraded',
      currentSegmentId: null,
      queueLength: 0,
      droppedCount: 0,
      suppressedCount: 0,
      invalidCount: 0,
      segmentCount: 0,
      lastWriteAt: null,
      lastCleanupAt: null,
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

const markSystemInactive = (): void => {
  systemInactive = true
  lastSampleAtMs = Date.now()
  lastSwitchApp = null
}

const markSystemActive = (): void => {
  systemInactive = false
  lastSampleAtMs = Date.now()
  lastSwitchApp = null
}

async function sampleTick(): Promise<void> {
  if (sampling) return
  sampling = true
  try {
    const now = Date.now()
    if (systemInactive) {
      // 锁屏/睡眠期间不补记；解锁后从新的采样窗口开始。
      lastSampleAtMs = now
      if (powerMonitor.getSystemIdleTime() >= IDLE_SKIP_SEC) return
      systemInactive = false
    }
    // 按真实流逝时间记账，而非名义周期：触发被丢/延迟也不少记；
    // 上限 2 个周期，防睡眠唤醒把整段睡眠补记进来
    const credit = Math.min(Math.round((now - lastSampleAtMs) / 1000), SAMPLE_SEC * 2)
    lastSampleAtMs = now
    if (credit <= 0 || watchPaused) return
    const context = await getFrontmostContext()
    if (systemInactive) return
    if (!context?.name) {
      markActivityObserverFailure('无法读取前台应用上下文')
      return
    }
    markActivityObserverHealthy()
    if (powerMonitor.getSystemIdleTime() >= IDLE_SKIP_SEC) return // 人不在电脑前
    if (systemInactive) return
    const frontApp = context.name
    const ownApp = isOwnApp(frontApp)
    const privacy = privacyForContext(context)
    const { privacyState } = privacy
    recordFrontmostContext(context, {
      suppressed: privacy.suppressed,
      observerHealthy: false,
      privacyState,
      nowMs: now
    })
    // 自己在前台不计（dev 是 Electron、正式包是谷子助手，统计自己只会污染榜单）；
    // 排除名单 App 照常计时——名单挡的是截图，不是「用了多久」
    if (ownApp) return
    addAppUsage(dayKey(new Date()), frontApp, credit)
    // 切换事件：注意力分析素材（平均专注时长/切换率/碎片化都靠它）
    if (lastSwitchApp && lastSwitchApp !== frontApp) addAppSwitch(lastSwitchApp, frontApp)
    lastSwitchApp = frontApp
  } finally {
    sampling = false
  }
}

function configureHistoryCollector(): void {
  const historyEnabled = getSettings().historyV2Enabled
  startHistoryPersistence()
  configureActivityHistoryPersistence({
    upsertSegment: upsertActivitySegment,
    addOcrEvidence,
    appendHistoryEvent: (event) => {
      if (historyPaused) return
      // Resolve the current singleton at callback time. A pause/resume can
      // replace the store while the collector itself remains running.
      historyStore?.append(event)
    }
  })
  // History-specific App/host filters are opt-in; keep the legacy screen
  // sensing privacy behavior unchanged while History v2 is disabled.
  startActivityCollector((context) => privacyForContext(context, historyEnabled))
  if (historyEnabled) startLegacyHistorySync()
  else stopLegacyHistorySync()
}

function startSampler(): void {
  stopSampler()
  systemInactive = false
  lastSampleAtMs = Date.now()
  powerMonitor.on('suspend', markSystemInactive)
  powerMonitor.on('lock-screen', markSystemInactive)
  powerMonitor.on('shutdown', markSystemInactive)
  powerMonitor.on('resume', markSystemActive)
  powerMonitor.on('unlock-screen', markSystemActive)
  configureHistoryCollector()
  configureSemanticWorkClassifier(scheduleSemanticWork)
  void sampleTick().catch(() => {})
  sampleTimer = setInterval(() => void sampleTick().catch(() => {}), SAMPLE_SEC * 1000)
}

/** Start native History without enabling the legacy OCR watcher or semantic model calls. */
function startHistoryCollectorOnly(): void {
  stopSampler()
  configureHistoryCollector()
}
function stopSampler(): void {
  if (sampleTimer) {
    clearInterval(sampleTimer)
    sampleTimer = null
  }
  powerMonitor.removeListener('suspend', markSystemInactive)
  powerMonitor.removeListener('lock-screen', markSystemInactive)
  powerMonitor.removeListener('shutdown', markSystemInactive)
  powerMonitor.removeListener('resume', markSystemActive)
  powerMonitor.removeListener('unlock-screen', markSystemActive)
  systemInactive = false
  stopLegacyHistorySync()
  stopActivityCollector()
  void stopHistoryPersistence()
  configureActivityHistoryPersistence({ upsertSegment: upsertActivitySegment, addOcrEvidence })
  configureSemanticWorkClassifier(null)
  stopSemanticWorkClassifier()
  lastSwitchApp = null // 停启之间的间隔不算一次「切换」
}

export function startWatch(intervalSec: number): void {
  stopWatch()
  resetActivityGate()
  lastWorkRecordAt = 0
  lastWorkRecordContent = ''
  lastWorkRecordTask = null
  lastWorkRecordApp = null
  startSampler()
  const minInterval = getSettings().screenSenseEventDriven ? 5 : 1
  watchTimer = setInterval(() => void watchTick(), Math.max(minInterval, intervalSec) * 1000)
  trayRefresh?.()
}
export function stopWatch(): void {
  watchAbort?.abort()
  watchAbort = null
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  stopSampler()
  lastHash = null
  lastTextHash = ''
  resetActivityGate()
  lastWorkRecordAt = 0
  lastWorkRecordContent = ''
  lastWorkRecordTask = null
  lastWorkRecordApp = null
  trayRefresh?.()
}
/** 托盘「暂停/恢复屏幕监控」：暂停时 watcher 仍在转但每轮直接 return */
export function setWatchPaused(paused: boolean): void {
  watchPaused = paused
  if (paused) {
    watchAbort?.abort()
    watchAbort = null
    stopSampler()
  } else {
    resetActivityGate()
    const settings = getSettings()
    if (settings.screenSenseEnabled && settings.screenSenseContinuous) startSampler()
    else if (settings.historyV2Enabled) startHistoryCollectorOnly()
  }
  trayRefresh?.()
}

export function screenActivityStatus(): ReturnType<typeof getActivityRuntimeStatus> {
  const { screenSenseEventDriven, screenSenseHybridV2 } = getSettings()
  return getActivityRuntimeStatus({
    eventDriven: screenSenseEventDriven,
    hybridV2: screenSenseHybridV2,
    running: isWatchActive(),
    paused: watchPaused
  })
}

/** 跟随设置开关注册/注销扫描快捷键 + 启停持续监控（启动时 + settings:save 时调用） */
export function applyScreenSenseSettings(): void {
  const { screenSenseEnabled, screenSenseHotkey, screenSenseContinuous, screenSenseIntervalSec, historyV2Enabled } =
    getSettings()
  if (screenSenseEnabled) initScanHotkey(screenSenseHotkey, () => void scanOnce())
  else unregisterScanHotkey()
  if (screenSenseEnabled && screenSenseContinuous) startWatch(screenSenseIntervalSec)
  else {
    stopWatch()
    if (historyV2Enabled) startHistoryCollectorOnly()
  }
  applyReportSchedule() // 每日定时日报跟随设置启停
  runShotRetention()
}

/**
 * 截图保留期清理（#53）：删超期的已落实截图 + 清未接受的临时截图。
 * 启动时 + settings:save 时跑（挂在 applyScreenSenseSettings）。
 */
export function runShotRetention(): void {
  try {
    const { screenSenseRetentionDays } = getSettings()
    const now = Date.now()
    const refs = listShotIds().map((id) => {
      const s = getSource(id)
      return { id, createdAtMs: s ? new Date(s.createdAt).getTime() : 0 }
    })
    for (const id of expiredShotIds(refs, screenSenseRetentionDays, now)) deleteShot(id)
    sweepTempShots(24 * 60 * 60 * 1000, now) // 未接受的临时缩略图 1 天清
  } catch {
    /* 清理失败不影响主流程 */
  }
}
