// 屏幕感知主线：手动扫描（scanOnce）与持续监控（watchTick）的门控、截图、OCR、云端解析编排。
// 检测卡/接受流在 detection-cards.ts，工作记录在 work-records.ts，History v2 生命周期在
// history/service.ts，前台采样在 usage-sampler.ts，隐私判定在 privacy.ts。
import { unlink } from 'fs/promises'
import { nativeImage, powerMonitor, systemPreferences } from 'electron'
import { captureScreenSilently, emptyParseSummary, HINTS } from './capture'
import { shouldTodoScan, todoScanAppKind } from '@shared/todo-scan'
import { ocrImageDetailed } from './ocr'
import { cloudReady, parseToItemsRaw } from './parser'
import { addOcrEvidence, getSettings, getSource, listFocusTaskCandidates } from './db'
import { applyReportSchedule } from './report-scheduler'
import { debugEvent, debugIsOpen, showPreview, isPreviewVisible } from './windows'
import { applyExternalPetSay, isPetVisible, setPetScanning } from './pet/controller'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { getFrontmostContext } from './frontapp'
import { saveShotTempFromPng, deleteShot, listShotIds, sweepTempShots } from './shotvault'
import { redactSensitive } from '@shared/sensitive'
import { looksLikeChat, clusterChatSpeakers, formatChatTranscript, type TextBox } from '@shared/chat-layout'
import { expiredShotIds } from '@shared/shot-retention'
import { dhash, hamming, bgraToGray, textHash } from '@shared/phash'
import { CooldownMap } from '@shared/cooldown'
import { parseFocusTask, parseWorkSummary } from '@shared/parsing'
import type { ScanResult } from '@shared/types'
import {
  activityScanDecision,
  getScreenActivityStatus as getActivityRuntimeStatus,
  markActivityObserverFailure,
  markActivityScan,
  configureActivityHistoryPersistence,
  configureSemanticWorkClassifier,
  getHybridSemanticState,
  markOcrFallback,
  recordFrontmostContext,
  recordOcrEvidence,
  recordScreenChange,
  resetActivityGate,
  startActivityCollector,
  stopActivityCollector,
  type ActivityScanReason
} from './activity-tracker'
import { decideOcrTrigger, type OcrTriggerReason } from '@shared/hybrid-history'
import { buildDetectionCards, parsedToExtraction, showDetectedCards, type DetectHit } from './detection-cards'
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
import { appendHistoryEventIfRunning, startHistoryPersistence, stopHistoryPersistence } from './history/service.ts'


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
      showPreview({ summary: emptyParseSummary(message) }) // 红色错误卡，手动关闭
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
      // manual=true：手动扫描是用户主动触发，全部候选都出卡，不做 isNew/强弱门控
      const cards = buildDetectionCards({ hits, sourceText: text, app: null, popup: true, manual: true })
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
    showPreview({ summary: emptyParseSummary(message) })
    return { status: 'error', message }
  } finally {
    setPetScanning(false)
  }
}

// ---------- 持续屏幕监控（事件门控 + 截图 fallback）----------
// 流水线：前台 App/窗口变化或硬兜底 → pHash → OCR → 文本冷却 → 云端解析 → 建议卡。
// pHash 算法与参数沿用 volcengine/MineContext（imagehash.dhash hash_size=8 + 异或 popcount 汉明距离；
// capture_interval 默认 5s、similarity_hash_threshold 默认 2），其为 Python+imagehash，此处用 TS 等价落地（见 @shared/phash）。

const PHASH_THRESHOLD = 2 // 汉明距离 ≤ 此值视为"屏幕没变" → 跳过 OCR/解析（MineContext 实测默认）
const COOLDOWN_MS = 10 * 60 * 1000 // 同一内容命中后冷却，避免反复弹卡

let watchTimer: ReturnType<typeof setInterval> | null = null
let watchPaused = false
let ticking = false
let watchAbort: AbortController | null = null
let lastHash: bigint | null = null
let lastTextHash = ''
let lastTodoScanAtMs: number | null = null // 待办识别通道的独立节流（与全局 OCR 冷却分开计）
let lastDebugApp: string | null | undefined = undefined // 调试日志：仅前台 App 变化时记一次，避免刷屏
// 订阅到期/额度用尽的云端退避：期间保留本地采样（时长/切换不花钱），跳过截图/OCR/上云；
// 通知只发一次，解析恢复成功后复位。曾因每 1-2s 白打一次 402 刷爆日志。
const CLOUD_PAUSE_MS = 10 * 60_000
let cloudPauseUntil = 0
let cloudPauseNotified = false
let previewBlockLogged = false // 调试日志：预览卡占用导致跳过只记一次，卡关掉后重置
let cloudBlockLogged = false // 调试日志：解析服务未就绪导致跳过只记一次，恢复后重置
const cooldown = new CooldownMap(COOLDOWN_MS)
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
    cooldown.sweep(now)
    const until = cooldown.untilMs(th)
    if (until && until > now) {
      debugEvent('record', '同内容冷却中，跳过')
      return
    }
    cooldown.start(th, now) // 命中或未命中都冷却，避免双屏来回切时反复跑模型

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

// ---------- 采集器接线（History collector + 语义归类 + 前台采样） ----------

function configureHistoryCollector(): void {
  const historyEnabled = getSettings().historyV2Enabled
  startHistoryPersistence()
  configureActivityHistoryPersistence({
    addOcrEvidence,
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
}
function stopSampler(): void {
  stopUsageSampler()
  stopActivityCollector()
  void stopHistoryPersistence()
  configureActivityHistoryPersistence({ addOcrEvidence })
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
  watchAbort = null
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  stopSampler()
  lastHash = null
  lastTextHash = ''
  resetActivityGate()
  resetWorkRecordThrottle()
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
