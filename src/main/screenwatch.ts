import { unlink } from 'fs/promises'
import { app, nativeImage, powerMonitor } from 'electron'
import { captureScreenSilently, excerptOf, HINTS } from './capture'
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
  setDetectionStatus,
  findDuplicateTitle
} from './db'
import { applyReportSchedule } from './report-scheduler'
import { dayKey } from '@shared/work-report'
import { broadcast, debugEvent, debugIsOpen, showPreview, isPreviewVisible } from './windows'
import { applyExternalPetSay, isPetVisible, setPetScanning } from './pet/controller'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { getFrontmostApp } from './frontapp'
import { saveShotTempFromPng, finalizeShot, deleteShot, listShotIds, sweepTempShots } from './shotvault'
import { getSession } from './session'
import { isAppExcluded } from '@shared/app-exclude'
import { redactSensitive } from '@shared/sensitive'
import { looksLikeChat, clusterChatSpeakers, formatChatTranscript, type TextBox } from '@shared/chat-layout'
import { expiredShotIds } from '@shared/shot-retention'
import { dhash, hamming, bgraToGray, textHash } from '@shared/phash'
import { parseFocusTask, parseWorkSummary, type AddedInfo, type ParsedItem } from '@shared/parsing'
import type { LocalExtraction, ParseSummary, ScanResult, TaskStatus } from '@shared/types'

function emptySummary(error: string | null): ParseSummary {
  return { sourceId: '', total: 0, related: 0, autoAdded: 0, duplicates: 0, error }
}

interface DetectHit {
  extraction: LocalExtraction
  item: ParsedItem
}

// 工作记录搭同一次识别调用的便车：让模型在 items 之外多回 work_summary + focus_task 两个顶层字段
function workSummaryHint(prevSummary: string, taskCandidates: string[]): string {
  const cand = taskCandidates.length ? `已知任务列表：${taskCandidates.join('、')}。` : ''
  const base =
    '另外，在返回的 JSON 中额外加两个顶层字段：' +
    '① "work_summary"：一句不超过 40 字的中文，客观描述屏幕上正在进行的**工作/学习活动**（如「在 VS Code 中编辑项目代码」）。与工作学习无关或信息量极低的画面（随意浏览文件夹、刷聊天/社交消息、系统设置页、视频娱乐等）填 null，不要硬凑。' +
    `② "focus_task"：该活动归属的任务名——任务级、粗粒度、名称稳定（如「开发谷子助手」「撰写博资考 PPT」）。${cand}优先复用已知任务名，确实是新任务再起新名；work_summary 为 null 时它也为 null。`
  // 传入上一条描述：同一活动持续中 → 原样返回同一句，让相邻记录能聚合成时段（避免措辞漂移拆成多段）
  return prevSummary
    ? `${base}\n若当前活动与上一条描述「${prevSummary}」本质相同，work_summary 请原样返回完全一致的字符串。`
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
  wantVlmConfirm: boolean
): Promise<DetectResult> {
  const hint = wantWorkLog
    ? `${HINTS.screen_scan}\n${workSummaryHint(lastWorkRecordContent, listFocusTaskCandidates())}`
    : HINTS.screen_scan
  const { items, raw } = await parseToItemsRaw({ text, hint })
  const workSummary = wantWorkLog ? parseWorkSummary(raw) : null
  const focusTask = wantWorkLog ? parseFocusTask(raw) : null
  let hits = items.map((it) => ({ extraction: parsedToExtraction(it), item: it }))

  if (wantVlmConfirm && png && hits.some(isScheduleCandidate)) {
    const imageDataUrl = cropForegroundDataUrl(png)
    if (imageDataUrl) {
      try {
        const t0 = Date.now()
        const { items: refined } = await parseToItemsRaw({ imageDataUrl, hint: HINTS.screen_scan_confirm })
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

// 工作记录节流：同一活动持续中不重复记；不同活动也至少间隔 1 分钟，防打字每帧都记
const WORK_RECORD_MIN_GAP_MS = 60 * 1000
let lastWorkRecordAt = 0
let lastWorkRecordContent = ''
function maybeAddWorkRecord(summary: string | null, task: string | null, frontApp: string | null): void {
  if (!summary) return
  const now = Date.now()
  if (summary === lastWorkRecordContent) return
  if (now - lastWorkRecordAt < WORK_RECORD_MIN_GAP_MS) return
  lastWorkRecordAt = now
  lastWorkRecordContent = summary
  addWorkRecord({ content: summary, app: frontApp, task })
  debugEvent('record', `工作记录：${summary}${task ? `（任务：${task}）` : ''}`)
}

/** 云端 ParsedItem → LocalExtraction（供 addDetection / 卡片显示）。 */
function parsedToExtraction(it: ParsedItem): LocalExtraction {
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

// ---------- 多任务卡片队列：一帧识别出多个待办时逐张弹、逐张确认 ----------
interface QueuedCard {
  suggestion: Record<string, unknown> // localSuggestion 载荷（卡显示 + 接受）
  detectionId: string
}
let cardQueue: QueuedCard[] = []
let activeQueuedId: string | null = null // 当前显示的队列卡 detectionId；null=队列空闲

/** 入队一批卡并弹首张。新扫描整批替换旧队列（watchTick 受 isPreviewVisible 门控不会并发，手动扫描即重扫）。 */
function enqueueCards(cards: QueuedCard[]): void {
  if (!cards.length) return
  const total = cards.length
  cards.forEach((c, i) => {
    c.suggestion.queueIndex = i + 1
    c.suggestion.queueTotal = total
  })
  cardQueue = cards.slice()
  activeQueuedId = null
  showNextQueued()
}

/** 弹队列下一张；空则归位。 */
function showNextQueued(): void {
  const card = cardQueue.shift()
  if (!card) {
    activeQueuedId = null
    return
  }
  activeQueuedId = card.detectionId
  showPreview({ localSuggestion: card.suggestion })
}

/** 预览卡关闭（同意/拒绝/闲置/AI 解析后最终都走 preview:hide）→ 若是队列卡则弹下一张。 */
export function onPreviewHidden(): void {
  if (activeQueuedId === null) return
  activeQueuedId = null
  showNextQueued()
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
      debugEvent('ocr', text ? `OCR 完成：${text.length} 字` : 'OCR 未识别到文字')
      if (red.hits.length) debugEvent('ocr', `已脱敏：${red.hits.join('、')}`)
      if (!text) {
        showPreview({ error: '屏幕上没有识别到文字' }) // 灰色提示卡，3s 自动消失
        return { status: 'empty', message: '屏幕上没有识别到文字' }
      }
      debugEvent('ocr-text', `\n---OCR 原文---\n${text.slice(0, 4000)}\n---END---`) // 诊断：落盘当次 OCR 全文

      const t0 = Date.now()
      const { hits, workSummary, focusTask } = await detectAll(text, screenSenseWorkLog, png, screenSenseVlmConfirm)
      debugEvent('timing', `云端解析耗时 ${Date.now() - t0}ms`)
      maybeAddWorkRecord(workSummary, focusTask, null)
      if (!hits.length) {
        debugEvent('detect', '云端未发现明确待办')
        showPreview({ error: '未发现可添加的日程' }) // 灰色提示卡，3s 自动消失
        return { status: 'empty', message: '未发现可添加的日程' }
      }
      if (screenSenseKeepShots) saveShotTempFromPng(textHash(text), png) // 整帧一张证据图
      const cards: QueuedCard[] = hits.map(({ extraction, item }) => {
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
      enqueueCards(cards) // 逐张弹（首张立即，后续随用户确认推进）
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
  broadcast('eshell:tasks-updated')
  return { candidate: 0, title: item.title, time, duplicate: false, taskId: task.id }
}

/** 检测历史条目 → ParsedItem（「记忆」页同意一条检测时重建入库载荷）。 */
function buildLocalItem(e: LocalExtraction): ParsedItem {
  return {
    title: e.title,
    item_type: 'other',
    belongs_to_user: e.belongsToUser,
    belonging_reason: '屏幕识别',
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

// ---------- 持续屏幕监控（#40 Phase 2）----------
// 流水线：pHash 变化门 → OCR → 文本去重/冷却 → 云端解析 → 建议卡。截图用完即弃、只文字上云。
// pHash 算法与参数沿用 volcengine/MineContext（imagehash.dhash hash_size=8 + 异或 popcount 汉明距离；
// capture_interval 默认 5s、similarity_hash_threshold 默认 2），其为 Python+imagehash，此处用 TS 等价落地（见 @shared/phash）。

const PHASH_THRESHOLD = 2 // 汉明距离 ≤ 此值视为"屏幕没变" → 跳过 OCR/解析（MineContext 实测默认）
const COOLDOWN_MS = 10 * 60 * 1000 // 同一内容命中后冷却，避免反复弹卡
const IDLE_SKIP_SEC = 120 // 键鼠闲置超此秒数视为人不在电脑前，整轮跳过（不截图/不统计/不上云）

let watchTimer: ReturnType<typeof setInterval> | null = null
let watchPaused = false
let ticking = false
let lastHash: bigint | null = null
let lastTextHash = ''
let lastDebugApp: string | null | undefined = undefined // 调试日志：仅前台 App 变化时记一次，避免刷屏
let lastSwitchApp: string | null = null // 切换事件：上一轮的前台应用（own-app/idle 轮不更新）
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
  // 保留旧名（纸壳助手/eshell）：改名前打包的旧进程名仍需排除
  return [app.getName(), 'electron', '谷子助手', 'gooz', '纸壳助手', 'eshell'].some(
    (n) => n && f.includes(n.toLowerCase())
  )
}

/** 云端解析可用性：已登录（网关）或已配直连 API，且完成档案设置。未就绪时监控静默跳过，不白跑截图/OCR。 */
function cloudReady(): boolean {
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
    if (powerMonitor.getSystemIdleTime() >= IDLE_SKIP_SEC) return // 人不在电脑前，静默跳过
    const {
      screenSenseExcludedApps,
      screenSenseKeepShots,
      screenSensePopup,
      screenSenseWorkLog,
      screenSenseVlmConfirm,
      screenSenseIntervalSec
    } = getSettings()
    // 截图前定前台 App：① 排除名单(硬隐私门) ② 不监控谷子助手自己。全屏感知，不再按进程名单过滤。
    const frontApp = await getFrontmostApp()
    const appChanged = frontApp !== lastDebugApp
    lastDebugApp = frontApp
    if (appChanged) debugEvent('frontapp', `前台应用：${frontApp ?? '(未知)'}`)
    // 应用使用时长：每轮给前台 App 记一个间隔（只存应用名+秒数；排除名单 App 也计时，但不截图；
    // 自己在前台不计——dev 下进程名是 Electron，正式包是谷子助手，统计自己只会污染榜单）
    if (frontApp && !isOwnApp(frontApp)) {
      addAppUsage(dayKey(new Date()), frontApp, Math.max(1, screenSenseIntervalSec))
      // 切换事件：注意力分析素材（平均专注时长/切换率/碎片化都靠它，周期采样会漏快速切换）
      if (lastSwitchApp && lastSwitchApp !== frontApp) addAppSwitch(lastSwitchApp, frontApp)
      lastSwitchApp = frontApp
    }
    if (screenSenseExcludedApps.length && isAppExcluded(frontApp, screenSenseExcludedApps)) {
      if (appChanged) debugEvent('skip', '在排除名单，跳过')
      return
    }
    if (isOwnApp(frontApp)) {
      if (appChanged) debugEvent('skip', '谷子助手自己在前台，跳过')
      return
    }
    if (Date.now() < cloudPauseUntil) return // 退避窗口内：采样已记完，不截图不上云

    png = await captureScreenSilently()
    if (!png) {
      debugEvent('error', '截图失败（检查屏幕录制权限）')
      return
    }
    const hash = await pHashOfPng(png)
    if (lastHash !== null && hamming(hash, lastHash) <= PHASH_THRESHOLD) return // 屏幕没变 → 静默跳过
    lastHash = hash
    debugEvent('screenshot', '屏幕有变化，已截图')
    debugShot(png)

    debugEvent('ocr', '本地 OCR 识别中…')
    const boxes = await ocrImageDetailed(png)
    // 上云前脱敏：证件/卡号/密钥类的值打码（后续存历史/查重/上云统一用打码后文本）
    const red = redactSensitive(buildOcrText(boxes))
    const text = red.text
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
    const { hits, workSummary, focusTask } = await detectAll(text, screenSenseWorkLog, png, screenSenseVlmConfirm)
    cloudPauseNotified = false // 解析成功 → 下次再断流时重新提醒
    maybeAddWorkRecord(workSummary, focusTask, frontApp)
    if (!hits.length) {
      debugEvent('detect', '云端未发现明确待办')
      return
    }

    let savedShot = false
    const cards: QueuedCard[] = []
    for (const { extraction, item } of hits) {
      debugEvent(
        'detect',
        `命中：「${extraction.title}」 ${extraction.isoTime ?? '无时间'} ${extraction.strong ? '[强]' : '[弱]'}`
      )
      // 被动留存 + 长期去重：跨状态按 标题+时间 去重；已记录过的内容不再重复抓取/弹窗
      const { detection, isNew } = addDetection({
        title: extraction.title,
        timeIso: extraction.isoTime,
        deadline: extraction.deadline,
        sourceText: text,
        hits: extraction.hits,
        app: frontApp
      })
      if (!isNew) {
        debugEvent('record', '已存在，不重复抓取')
        continue
      }
      debugEvent('record', '已记入「记忆」历史（新）')
      // 截图持久化（#52/#53）：趁 png 还在存整帧证据图（一张）
      if (screenSenseKeepShots && png && !savedShot) {
        saveShotTempFromPng(th, png)
        savedShot = true
      }
      // 少量主动：仅强信号 + 弹窗开关开才进弹卡队列
      if (!extraction.strong || !screenSensePopup) {
        debugEvent('popup', '不弹卡（弱信号或弹窗关），留在记忆历史')
        continue
      }
      cards.push({
        suggestion: { ...extraction, item, sourceText: text, detectionId: detection.id },
        detectionId: detection.id
      })
    }
    if (!cards.length) return
    // 新鲜度门：仍在同一 App 才弹（切走了就只留历史）
    if (frontApp && (await getFrontmostApp()) !== frontApp) {
      debugEvent('popup', '已切走 App，不弹')
      return
    }
    debugEvent('popup', `弹出检测卡：${cards.length} 张`)
    enqueueCards(cards)
    applyExternalPetSay(cards.length > 1 ? `发现 ${cards.length} 个日程~` : '发现一个日程~', 'waiting')
  } catch (e) {
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
    ticking = false
  }
}

export function startWatch(intervalSec: number): void {
  stopWatch()
  watchTimer = setInterval(() => void watchTick(), Math.max(1, intervalSec) * 1000)
  trayRefresh?.()
}
export function stopWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  lastHash = null
  lastTextHash = ''
  trayRefresh?.()
}
/** 托盘「暂停/恢复屏幕监控」：暂停时 watcher 仍在转但每轮直接 return */
export function setWatchPaused(paused: boolean): void {
  watchPaused = paused
  trayRefresh?.()
}

/** 跟随设置开关注册/注销扫描快捷键 + 启停持续监控（启动时 + settings:save 时调用） */
export function applyScreenSenseSettings(): void {
  const { screenSenseEnabled, screenSenseHotkey, screenSenseContinuous, screenSenseIntervalSec } =
    getSettings()
  if (screenSenseEnabled) initScanHotkey(screenSenseHotkey, () => void scanOnce())
  else unregisterScanHotkey()
  if (screenSenseEnabled && screenSenseContinuous) startWatch(screenSenseIntervalSec)
  else stopWatch()
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
