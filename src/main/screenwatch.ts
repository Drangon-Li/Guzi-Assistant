// 屏幕感知主线：手动扫描（scanOnce）与持续监控（watchTick）的门控、截图、OCR、云端解析编排。
// 检测卡/接受流在 detection-cards.ts，工作记录在 work-records.ts，History v2 生命周期在
// history/service.ts，前台采样在 usage-sampler.ts，隐私判定在 privacy.ts。
import { unlink } from 'fs/promises'
import { nativeImage, powerMonitor, systemPreferences } from 'electron'
import { captureScreenSilently, emptyParseSummary, HINTS } from './capture'
import { shouldTodoScan, todoScanAppKind } from '@shared/todo-scan'
import { ocrImageDetailed } from './ocr'
import { cloudReady, parseToItemsRaw } from './parser'
import { getSettings, getSource, listFocusTaskCandidates, compareActivityUsage } from './db'
import { dayKey } from '@shared/work-report'
import { applyReportSchedule } from './report-scheduler'
import { debugEvent, debugIsOpen, hideMainForCapture, showPreview, isPreviewVisible } from './windows'
import { applyExternalPetSay, isPetVisible, setPetScanning } from './pet/controller'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { getScreenSnapshot } from './frontapp'
import { sameScreenContext, screenWindowKey, snapshotContext, snapshotSafetyReason, ScreenCaptureBlocked } from './screen-snapshot.ts'
import { ScanGeneration, ScreenRetryState } from './screen-retry.ts'
import { saveShotTempFromPng, deleteShot, listShotIds, sweepTempShots } from './shotvault'
import { redactSensitive } from '@shared/sensitive'
import { looksLikeChat, clusterChatSpeakers, formatChatTranscript, type TextBox } from '@shared/chat-layout'
import { expiredShotIds } from '@shared/shot-retention'
import { dhash, bgraToGray, textHash } from '@shared/phash'
import { parseFocusTask, parseWorkSummary } from '@shared/parsing'
import type { ScanResult } from '@shared/types'
import {
  activityScanDecision,
  getScreenActivityStatus as getActivityRuntimeStatus,
  markActivityScan,
  configureActivityHistoryPersistence,
  configureSemanticWorkClassifier,
  getHybridSemanticState,
  getCollectorCaptureSafety,
  markOcrFallback,
  recordOcrEvidence,
  recordScreenChange,
  resetActivityGate,
  startActivityCollector,
  stopActivityCollector,
  type ActivityScanReason
} from './activity-tracker'
import { decideOcrTrigger, type OcrTriggerReason } from '@shared/hybrid-history'
import {
  buildDetectionCards,
  parsedToExtraction,
  showDetectedCards,
  sweepCompletedDetections,
  type DetectHit
} from './detection-cards'
import { detectionQueueDecision } from '@shared/detection-gate'
import {
  legacyWorkSummaryHint,
  maybeAddWorkRecord,
  resetWorkRecordThrottle,
  scheduleSemanticWork,
  shouldPersistLegacyOcrWork,
  stopSemanticWorkClassifier,
  workSummaryHint
} from './work-records'
import { privacyForContext } from './privacy'
import { IDLE_SKIP_SEC, startUsageSampler, stopUsageSampler } from './usage-sampler'
import { appendHistoryEventIfRunning, appendOcrEvidenceIfAllowed, historyContentAllowed, getHistoryContentEpoch, startHistoryPersistence, stopHistoryPersistence } from './history/service.ts'


/** The input is already an exact window image; preserve its full content. */
function windowImageDataUrl(png: string): string | null {
  try {
    const img = nativeImage.createFromPath(png)
    const { width, height } = img.getSize()
    if (!width || !height) return null
    const sized = width > 2000 ? img.resize({ width: 2000 }) : img
    return `data:image/jpeg;base64,${sized.toJPEG(72).toString('base64')}`
  } catch { return null }
}

/**
 * 一个候选是否「值得花一次视觉确认」：只要它打算进待确认队列就值得。
 *
 * 原先要求「已解出具体时间」才复查，于是越像噪声的越没人管——一屏 37 条无时间候选，
 * 复查员一次都没被叫醒（#128）。反过来，没时间的恰恰最需要再看一眼版面；
 * 而没过入队门槛的那些压根不会打扰用户，也就不必为它们花一次视觉调用。
 */
function isScheduleCandidate(h: DetectHit): boolean {
  return detectionQueueDecision(h.item, h.extraction.strong) === 'queue'
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
 * ② 若开启视觉确认且出现「值得确认」的日程候选，把当帧窗口截图发视觉模型深度确认，
 *    以视觉结果为准（空=文字层假阳性，丢弃）。png 为 null（如手动无图路径）时跳过②。
 */
async function detectAll(
  text: string,
  wantWorkLog: boolean,
  png: string | null,
  wantVlmConfirm: boolean,
  signal?: AbortSignal,
  beforeVisualUpload?: () => Promise<void>
): Promise<DetectResult> {
  const hint = wantWorkLog
    ? `${HINTS.screen_scan}\n${workSummaryHint(legacyWorkSummaryHint(), listFocusTaskCandidates())}`
    : HINTS.screen_scan
  const { items, raw } = await parseToItemsRaw({ text, hint, signal })
  const workSummary = wantWorkLog ? parseWorkSummary(raw) : null
  const focusTask = wantWorkLog ? parseFocusTask(raw) : null
  const hits = items.map((it) => ({ extraction: parsedToExtraction(it), item: it }))

  signal?.throwIfAborted()
  if (wantVlmConfirm && png && hits.some(isScheduleCandidate)) {
    const imageDataUrl = windowImageDataUrl(png)
    if (imageDataUrl) {
      await beforeVisualUpload?.()
      signal?.throwIfAborted()
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
    }
  }
  return { hits, workSummary, focusTask, confirmed: false }
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

/** 让开主窗后等焦点交还给上一个应用；快照读的是系统当前前台，切换不是瞬时的 */
const FOCUS_SETTLE_MS = 350

/** 扫描一次当前屏幕：截图 → 本地 OCR → 云端解析 → 右下角弹建议卡 */
export async function scanOnce(): Promise<ScanResult> {
  // 桌宠可见时用 Siri 式光环表达"正在扫描"；否则退回加载卡（让用户知道在工作）
  const petGlow = isPetVisible()
  if (petGlow) setPetScanning(true)
  else showPreview({ busy: '正在扫描屏幕…' })
  debugEvent('tick', '手动扫描屏幕')
  const ticket = scans.begin()
  retries.reset() // Manual retry also releases a previous configuration failure.
  let restoreMain: (() => void) | null = null
  try {
    let snapshot = await getScreenSnapshot(ticket.signal)
    const context = snapshot ? snapshotContext(snapshot) : null
    let privacy = context ? privacyForContext(context) : { suppressed: true, privacyState: 'normal' as const }
    // 手动扫描时前台几乎必然是谷子助手自己——用户就是点着界面上的按钮触发的。
    // 与其报「隐私抑制」把人挡回去（#128 之外的老问题），不如把主窗让开再截，截完恢复。
    if (privacy.privacyState === 'own') {
      restoreMain = hideMainForCapture()
      if (restoreMain) {
        await new Promise((r) => setTimeout(r, FOCUS_SETTLE_MS))
        snapshot = await getScreenSnapshot(ticket.signal)
        privacy = snapshot ? privacyForContext(snapshotContext(snapshot)) : { suppressed: true, privacyState: 'normal' as const }
      }
    }
    const safetyReason = snapshotSafetyReason(snapshot) || (snapshot ? getCollectorCaptureSafety(snapshot).reason : null)
    if (privacy.suppressed || safetyReason) {
      const message = safetyReason || '当前窗口处于隐私抑制状态，未执行扫描'
      debugEvent('skip', message)
      showPreview({ error: message })
      return { status: 'empty', message }
    }
    markActivityScan('manual')
    const activityContext = snapshot ? { ...snapshotContext(snapshot), urlHost: getCollectorCaptureSafety(snapshot).urlHost } : null
    const historyEpoch = getHistoryContentEpoch()
    markOcrFallback('manual')
    const png = await captureScreenSilently(snapshot, ticket.signal)
    restoreMain?.() // 图已到手，窗口立刻还给用户——后面的 OCR 和云端解析不该让人干等
    if (!png) {
      const message = '截图失败，请检查屏幕录制权限'
      debugEvent('error', message)
      showPreview({ summary: emptyParseSummary(message) }) // 红色错误卡，手动关闭
      return { status: 'error', message }
    }
    debugShot(png)

    const { screenSenseKeepShots, screenSenseWorkLog, screenSenseVlmConfirm } = getSettings()
    // png 保留到 OCR/确认/存证之后再删，故包一层 try/finally
    try {
      const boxes = await ocrImageDetailed(png, ticket.signal)
      ticket.signal.throwIfAborted()
      // 上云前脱敏：证件/卡号/密钥类的值打码（后续存历史/查重/上云统一用打码后文本）
      const red = redactSensitive(buildOcrText(boxes))
      const text = red.text

      debugEvent('ocr', text ? `OCR 完成：${text.length} 字` : 'OCR 未识别到文字')
      if (red.hits.length) debugEvent('ocr', `已脱敏：${red.hits.join('、')}`)
      if (!text) {
        showPreview({ error: '屏幕上没有识别到文字' }) // 灰色提示卡，3s 自动消失
        return { status: 'empty', message: '屏幕上没有识别到文字' }
      }
      debugEvent('ocr-text', `OCR 原文已处理：${text.length} 字（内容不写诊断日志）`)

      const t0 = Date.now()
      const { hits, workSummary, focusTask } = await detectAll(
        text, screenSenseWorkLog, png, screenSenseVlmConfirm, ticket.signal,
        async () => {
          ticket.signal.throwIfAborted()
          if (!snapshot || privacyForContext(snapshotContext(snapshot)).suppressed)
            throw new ScreenCaptureBlocked('视觉确认前捕获窗口的隐私设置发生变化，已取消上传')
        }
      )
      if (!ticket.current()) return { status: 'empty', message: '扫描已取消' }
      sweepCompletedDetections(text)
      if (activityContext && historyContentAllowed(activityContext, historyEpoch)) recordOcrEvidence({
        eventId: null,
        occurredAtMs: snapshot!.observedAtMs,
        appName: snapshot?.name ?? null,
        bundleId: snapshot?.bundleId ?? null,
        windowTitle: snapshot?.windowTitle ?? null,
        windowId: snapshot?.windowId,
        urlHost: activityContext?.urlHost,
        semanticScore: 0,
        triggerReason: 'manual',
        redactionHits: red.hits,
        redactedText: text,
        privacyState: privacy.privacyState
      })
      debugEvent('timing', `云端解析耗时 ${Date.now() - t0}ms`)
      if (activityContext && historyContentAllowed(activityContext, historyEpoch))
        maybeAddWorkRecord(workSummary, focusTask, snapshot?.name ?? null, 'ocr')
      if (!hits.length) {
        debugEvent('detect', '云端未发现明确待办')
        showPreview({ error: '未发现可添加的日程' }) // 灰色提示卡，3s 自动消失
        return { status: 'empty', message: '未发现可添加的日程' }
      }
      if (screenSenseKeepShots) saveShotTempFromPng(textHash(text), png) // 整帧一张证据图
      // manual=true：手动扫描是用户主动触发，全部候选都出卡，不做 isNew/强弱门控
      const cards = buildDetectionCards({ hits, sourceText: text, app: null, popup: true, manual: true })
      showDetectedCards(cards) // 一条走单卡，多条汇成一张清单卡
      applyExternalPetSay(hits.length > 1 ? `发现 ${hits.length} 个日程~` : '发现一个日程~', 'waiting')
      return {
        status: 'suggested',
        message: hits.length > 1 ? `检测到 ${hits.length} 个可能的日程` : `检测到可能的日程：${hits[0].extraction.title}`
      }
    } finally {
      await unlink(png).catch(() => {}) // 原图用完即弃（检测/升级裁剪后）；只可能留加密缩略图
    }
  } catch (e) {
    if (!ticket.current()) return { status: 'empty', message: '扫描已取消' }
    const message = e instanceof Error ? e.message : String(e)
    showPreview({ summary: emptyParseSummary(message) })
    return { status: 'error', message }
  } finally {
    restoreMain?.() // 幂等，正常路径截完就已恢复过；这里兜住提前 return 和抛错
    ticket.finish()
    setPetScanning(false)
  }
}

// ---------- 持续屏幕监控（事件门控 + 截图 fallback）----------
// 流水线：前台 App/窗口变化或硬兜底 → pHash → OCR → 文本冷却 → 云端解析 → 建议卡。
// pHash 算法与参数沿用 volcengine/MineContext（imagehash.dhash hash_size=8 + 异或 popcount 汉明距离；
// capture_interval 默认 5s、similarity_hash_threshold 默认 2），其为 Python+imagehash，此处用 TS 等价落地（见 @shared/phash）。

const PHASH_THRESHOLD = 2 // 汉明距离 ≤ 此值视为"屏幕没变" → 跳过 OCR/解析（MineContext 实测默认）

let watchTimer: ReturnType<typeof setInterval> | null = null
let watchPaused = false
let ticking = false
let watchAbort: AbortController | null = null
const retries = new ScreenRetryState()
const scans = new ScanGeneration()
let lastTodoScanAtMs: number | null = null // 待办识别通道的独立节流（与全局 OCR 冷却分开计）
let lastDebugApp: string | null | undefined = undefined // 调试日志：仅前台 App 变化时记一次，避免刷屏
let previewBlockLogged = false // 调试日志：预览卡占用导致跳过只记一次，卡关掉后重置
let screenshotPauseReason: string | null = null
let cloudBlockLogged = false // 调试日志：解析服务未就绪导致跳过只记一次，恢复后重置
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
  const ticket = scans.begin()
  controller.signal.addEventListener('abort', () => scans.cancel(), { once: true })
  const signal = ticket.signal
  let attemptKey: string | null = null
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
    const snapshot = await getScreenSnapshot(signal)
    if (!ticket.current()) return
    const safetyReason = snapshotSafetyReason(snapshot) || (snapshot ? getCollectorCaptureSafety(snapshot).reason : null)
    if (safetyReason || !snapshot) {
      screenshotPauseReason = safetyReason || '前台上下文不可用，自动采集 fail-closed'
      debugEvent('skip', screenshotPauseReason)
      return
    }
    screenshotPauseReason = null
    const context = snapshotContext(snapshot)
    const activityContext = { ...context, urlHost: getCollectorCaptureSafety(snapshot).urlHost }
    const historyEpoch = getHistoryContentEpoch()
    const frontApp = context.name
    const appChanged = frontApp !== lastDebugApp
    lastDebugApp = frontApp
    if (appChanged) debugEvent('frontapp', `前台应用：${frontApp}`)
    const { suppressed, privacyState } = privacyForContext(context)
    if (suppressed) {
      if (appChanged) debugEvent('skip', '当前窗口处于隐私抑制状态，跳过')
      return
    }
    attemptKey = screenWindowKey(snapshot)
    if (!retries.ready(attemptKey, Date.now())) return
    const retryDue = retries.retryDue(attemptKey, Date.now())

    const decision = activityScanDecision(
      screenSenseEventDriven,
      screenSenseFallbackIntervalSec
    )
    const gateEligible =
      retryDue || decision.run || (screenSenseHybridV2 && decision.reason === 'observer_unavailable')
    if (!gateEligible) return
    const semanticState = getHybridSemanticState()
    const screenAllowed =
      process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted'
    if (!screenAllowed) {
      screenshotPauseReason = '缺少屏幕录制权限，已暂停截图'
      return
    }
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
    if (!trigger.run && !retryDue) {
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
    markActivityScan(retryDue ? 'hard_fallback' : decision.reason === 'observer_unavailable' ? 'event' : (decision.reason as ActivityScanReason))
    const triggerReason: OcrTriggerReason = retryDue ? 'partial_retry' : trigger.reason as OcrTriggerReason
    markOcrFallback(triggerReason)
    debugEvent('ocr-trigger', `按需 OCR：${trigger.reason}（semantic=${semanticState.assessment.score}）`)

    png = await captureScreenSilently(snapshot, signal)
    if (signal.aborted) return
    if (!png) {
      throw new Error('截图失败（检查屏幕录制权限）')
    }
    const hash = await pHashOfPng(png)
    const attempt = retries.state(attemptKey)
    attempt.observedHash = hash
    if (retries.shouldSkipHash(attemptKey, hash, Date.now(), PHASH_THRESHOLD)) return
    recordScreenChange(context)
    debugEvent('screenshot', '屏幕有变化，已截图')
    debugShot(png)

    debugEvent('ocr', '本地 OCR 识别中…')
    const boxes = await ocrImageDetailed(png, signal)
    if (signal.aborted) return
    // 上云前脱敏：证件/卡号/密钥类的值打码（后续存历史/查重/上云统一用打码后文本）
    const red = redactSensitive(buildOcrText(boxes))
    const text = red.text

    if (!text) {
      retries.markEmptyOcr(attemptKey, hash, Date.now())
      return
    }
    debugEvent('ocr', `OCR 完成：${text.length} 字`)
    if (red.hits.length) debugEvent('ocr', `已脱敏：${red.hits.join('、')}`)
    const th = textHash(text)
    if (retries.shouldSkipText(attemptKey, th, Date.now())) return

    const beforeUpload = await getScreenSnapshot(signal)
    if (!beforeUpload || snapshotSafetyReason(beforeUpload) || getCollectorCaptureSafety(beforeUpload).blocked || privacyForContext(snapshotContext(beforeUpload)).suppressed || !sameScreenContext(snapshot, beforeUpload))
      throw new ScreenCaptureBlocked('解析前窗口或安全状态发生变化，已丢弃截图')
    // 云端解析 → 全部候选（多任务）+ 顺带的工作记录
    const { hits, workSummary, focusTask } = await detectAll(
      text,
      screenSenseWorkLog,
      png,
      screenSenseVlmConfirm,
      signal,
      async () => {
        const beforeVisual = await getScreenSnapshot(signal)
        if (!beforeVisual || snapshotSafetyReason(beforeVisual) || getCollectorCaptureSafety(beforeVisual).blocked ||
          privacyForContext(snapshotContext(beforeVisual)).suppressed || !sameScreenContext(snapshot, beforeVisual))
          throw new ScreenCaptureBlocked('视觉确认前窗口或安全状态发生变化，已取消上传')
      }
    )
    if (signal.aborted) return
    const afterModel = await getScreenSnapshot(signal)
    if (!ticket.current()) return
    if (!afterModel || snapshotSafetyReason(afterModel) || getCollectorCaptureSafety(afterModel).blocked || privacyForContext(snapshotContext(afterModel)).suppressed || !sameScreenContext(snapshot, afterModel))
      throw new ScreenCaptureBlocked('解析期间窗口或安全状态发生变化，已丢弃结果')
    retries.succeed(attemptKey, hash, th)
    sweepCompletedDetections(text)
    if (triggerReason === 'todo_scan') lastTodoScanAtMs = Date.now()
    if (historyContentAllowed(activityContext, historyEpoch)) recordOcrEvidence({
      eventId: null,
      occurredAtMs: snapshot.observedAtMs,
      appName: frontApp,
      bundleId: context.bundleId,
      windowTitle: context.windowTitle,
      windowId: snapshot.windowId,
      urlHost: activityContext.urlHost,
      semanticScore: semanticState.assessment.score,
      triggerReason,
      redactionHits: red.hits,
      redactedText: text,
      privacyState
    })
    if (historyContentAllowed(activityContext, historyEpoch) && shouldPersistLegacyOcrWork(triggerReason))
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
    const freshSnapshot = await getScreenSnapshot(signal)
    const freshContext = freshSnapshot ? snapshotContext(freshSnapshot) : null
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
    if (e instanceof ScreenCaptureBlocked) screenshotPauseReason = msg
    debugEvent('error', `监控轮异常：${msg}`)
    if (attemptKey && !(e instanceof ScreenCaptureBlocked)) retries.fail(attemptKey, e, Date.now())
  } finally {
    if (png) await unlink(png).catch(() => {})
    if (watchAbort === controller) watchAbort = null
    ticket.finish()
    ticking = false
  }
}

// ---------- 采集器接线（History collector + 语义归类 + 前台采样） ----------

function configureHistoryCollector(): void {
  const historyEnabled = getSettings().historyV2Enabled
  startHistoryPersistence()
  configureActivityHistoryPersistence({
    addOcrEvidence: appendOcrEvidenceIfAllowed,
    appendHistoryEvent: appendHistoryEventIfRunning
  })
  // History-specific App/host filters are opt-in; keep the legacy screen
  // sensing privacy behavior unchanged while History v2 is disabled.
  startActivityCollector((context) => privacyForContext(context, historyEnabled))
}

function startSampler(): void {
  stopSampler()
  configureHistoryCollector()
  configureSemanticWorkClassifier(scheduleSemanticWork)
  startUsageSampler(() => watchPaused)
}

/** Start native History without enabling the legacy OCR watcher or semantic model calls. */
function startHistoryCollectorOnly(): void {
  stopSampler()
  configureHistoryCollector()
  startUsageSampler(() => watchPaused)
}
function stopSampler(): void {
  stopUsageSampler()
  stopActivityCollector()
  void stopHistoryPersistence()
  configureActivityHistoryPersistence({ addOcrEvidence: appendOcrEvidenceIfAllowed })
  configureSemanticWorkClassifier(null)
  stopSemanticWorkClassifier()
}

export function startWatch(intervalSec: number): void {
  stopWatch()
  resetActivityGate()
  resetWorkRecordThrottle()
  startSampler()
  const minInterval = getSettings().screenSenseEventDriven ? 5 : 1
  watchTimer = setInterval(() => void watchTick(), Math.max(minInterval, intervalSec) * 1000)
  trayRefresh?.()
}
export function stopWatch(): void {
  watchAbort?.abort()
  scans.cancel()
  watchAbort = null
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  stopSampler()
  retries.reset()
  lastTodoScanAtMs = null
  resetActivityGate()
  resetWorkRecordThrottle()
  trayRefresh?.()
}
/** 托盘「暂停/恢复屏幕监控」：暂停时 watcher 仍在转但每轮直接 return */
export function setWatchPaused(paused: boolean): void {
  watchPaused = paused
  if (paused) {
    watchAbort?.abort()
    scans.cancel()
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

export function resetScreenRecognitionRetry(): void {
  retries.reset()
  scans.cancel()
  watchAbort?.abort()
  screenshotPauseReason = null
}

export function screenActivityStatus(): ReturnType<typeof getActivityRuntimeStatus> & { screenshotPauseReason: string | null; activityTimelineComparison: ReturnType<typeof compareActivityUsage> } {
  const { screenSenseEventDriven, screenSenseHybridV2 } = getSettings()
  return { ...getActivityRuntimeStatus({
    eventDriven: screenSenseEventDriven,
    hybridV2: screenSenseHybridV2,
    running: isWatchActive(),
    paused: watchPaused
  }), screenshotPauseReason, activityTimelineComparison: compareActivityUsage(dayKey(new Date())) }
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
