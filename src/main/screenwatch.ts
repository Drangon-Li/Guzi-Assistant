import { unlink } from 'fs/promises'
import { app, nativeImage } from 'electron'
import { captureScreenSilently, excerptOf, HINTS } from './capture'
import { ocrImageDetailed } from './ocr'
import { parseToItems } from './parser'
import {
  addDetection,
  createSource,
  createTask,
  deleteSourceRow,
  getDetection,
  getSettings,
  getSource,
  setDetectionStatus,
  taskExists
} from './db'
import { broadcast, debugEvent, debugIsOpen, showPreview, isPreviewVisible } from './windows'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { getFrontmostApp } from './frontapp'
import {
  saveShotTempFromPng,
  finalizeShot,
  deleteShot,
  listShotIds,
  sweepTempShots
} from './shotvault'
import { matchKeywords } from '@shared/keywords'
import { detectLocalSchedule } from '@shared/local-extract'
import { pickBest } from '@shared/suggest'
import { isAppExcluded } from '@shared/app-exclude'
import { looksLikeChat, clusterChatSpeakers, formatChatTranscript } from '@shared/chat-layout'
import { expiredShotIds } from '@shared/shot-retention'
import { dhash, hamming, bgraToGray, textHash } from '@shared/phash'
import type { AddedInfo, ParsedItem } from '@shared/parsing'
import type { ParseSummary, ScanResult, TaskStatus } from '@shared/types'

function emptySummary(error: string | null): ParseSummary {
  return { sourceId: '', total: 0, related: 0, autoAdded: 0, duplicates: 0, error }
}

/** OCR 文本；若像聊天界面（#54），前置「谁说的」转写作归属信号，保留全文。 */
async function ocrTextForParse(png: string): Promise<string> {
  const boxes = await ocrImageDetailed(png)
  const text = boxes.map((b) => b.text).join('\n')
  if (!text) return ''
  if (looksLikeChat(boxes)) {
    const transcript = formatChatTranscript(clusterChatSpeakers(boxes))
    if (transcript) return `【聊天记录·谁说的】\n${transcript}\n\n【屏幕全文】\n${text}`
  }
  return text
}

/** 扫描一次当前屏幕：截图 → 本地 OCR → 解析 → 选最优 → 右下角弹建议卡 */
export async function scanOnce(): Promise<ScanResult> {
  // 触发后立刻弹"正在扫描"加载卡，否则截图/OCR/解析这几秒里用户不知道 纸壳助手 在工作
  showPreview({ busy: '正在扫描屏幕…' })
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

    const { screenSenseKeywords, screenSenseKeepShots } = getSettings()
    let text: string
    try {
      text = await ocrTextForParse(png)
      // 截图持久化（#52/#53，opt-in）：趁 png 还在，按 textHash 存加密临时缩略图
      if (text && screenSenseKeepShots) saveShotTempFromPng(textHash(text), png)
    } finally {
      void unlink(png).catch(() => {}) // 原图始终用完即弃；只可能留加密缩略图
    }
    debugEvent('ocr', text ? `OCR 完成：${text.length} 字` : 'OCR 未识别到文字')
    if (!text) {
      showPreview({ error: '屏幕上没有识别到文字' }) // 灰色提示卡，3s 自动消失
      return { status: 'empty', message: '屏幕上没有识别到文字' }
    }

    // 本地优先:不上云,本地严格门(关键词 + 时间线索)即时判断,延迟≈0
    const local = detectLocalSchedule(text, screenSenseKeywords)
    if (!local) {
      debugEvent('detect', '本地未命中（无关键词或无明确时间）')
      showPreview({ error: '未发现明确的待办事项' })
      return { status: 'empty', message: '未发现明确的待办事项' }
    }
    debugEvent('detect', `本地命中：「${local.title}」 ${local.isoTime ?? local.timeText}`)
    const { detection } = addDetection({
      title: local.title,
      timeIso: local.isoTime,
      deadline: local.deadline,
      sourceText: text,
      hits: local.hits,
      app: null
    })
    showPreview({ localSuggestion: { ...local, sourceText: text, detectionId: detection.id } })
    return { status: 'suggested', message: `检测到可能的日程：${local.title}` }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    showPreview({ summary: emptySummary(message) })
    return { status: 'error', message }
  }
}

/** 建议卡点"同意/修改"时入库：来源存 OCR 文字（非图），任务直接进日程 */
export function acceptSuggestion(payload: { item: ParsedItem; sourceText: string }): AddedInfo {
  const { item, sourceText } = payload
  const source = createSource({
    type: 'screen_scan',
    excerpt: excerptOf(sourceText),
    content: sourceText.slice(0, 20000),
    filePath: null
  })
  const time = item.due_time ?? item.start_time
  if (taskExists(item.title, item.due_time)) {
    deleteSourceRow(source.id) // 没有任务引用的来源不留库
    return { candidate: 0, title: item.title, time, duplicate: true, item }
  }
  const status: TaskStatus = item.due_time || item.start_time ? 'scheduled' : 'not_started'
  createTask({
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
  return { candidate: 0, title: item.title, time, duplicate: false }
}

/** 按需 AI 精修:对屏幕文字跑云端解析、挑最优项（供建议卡「AI 精确解析」按钮）。无明确事项返回 null。 */
export async function aiParse(
  sourceText: string
): Promise<{ item: ParsedItem; sourceText: string; hits: string[] } | null> {
  debugEvent('cloud', '云端 AI 解析中…')
  const items = await parseToItems({ text: sourceText, hint: HINTS.screen_scan })
  const best = pickBest(items)
  debugEvent('cloud', best ? `云端解析完成：「${best.title}」` : '云端解析完成：未发现明确事项')
  if (!best) return null
  return { item: best, sourceText, hits: matchKeywords(sourceText, getSettings().screenSenseKeywords) }
}

/** 本地粗信息 → ParsedItem（归属未判定，交用户确认）。同意本地候选/历史共用。 */
function buildLocalItem(title: string, isoTime: string | null, deadline: boolean): ParsedItem {
  return {
    title,
    item_type: 'other',
    belongs_to_user: 'uncertain',
    belonging_reason: '本地识别（未经 AI 判断归属）',
    user_role: 'unclear',
    start_time: deadline ? null : isoTime,
    due_time: deadline ? isoTime : null,
    location: null,
    priority: 'unknown',
    confidence: 0.5,
    suggested_action: 'confirm',
    notes: [],
    evidence: [],
    duplicate_of: null
  }
}

/** 同意本地候选:直接入库（不上云）；带 detectionId 则把该历史记录标记为已加入。 */
export function acceptLocal(payload: {
  title: string
  isoTime: string | null
  deadline: boolean
  sourceText: string
  detectionId?: string
}): AddedInfo {
  const info = acceptSuggestion({
    item: buildLocalItem(payload.title, payload.isoTime, payload.deadline),
    sourceText: payload.sourceText
  })
  if (payload.detectionId) setDetectionStatus(payload.detectionId, 'accepted')
  return info
}

/** 从「记忆」历史里同意一条检测 → 入库并标记 accepted。 */
export function acceptDetection(id: string): AddedInfo | null {
  const d = getDetection(id)
  if (!d) return null
  const info = acceptSuggestion({
    item: buildLocalItem(d.title, d.timeIso, d.deadline),
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
// 流水线：pHash 变化门 → OCR → 文本去重 → 关键词相关门 → 解析 → 建议卡。截图用完即弃、只文字上云。
// pHash 算法与参数沿用 volcengine/MineContext（imagehash.dhash hash_size=8 + 异或 popcount 汉明距离；
// capture_interval 默认 5s、similarity_hash_threshold 默认 2），其为 Python+imagehash，此处用 TS 等价落地（见 @shared/phash）。

const PHASH_THRESHOLD = 2 // 汉明距离 ≤ 此值视为"屏幕没变" → 跳过 OCR/云（MineContext 实测默认）
const COOLDOWN_MS = 10 * 60 * 1000 // 同一内容命中后冷却，避免反复弹卡

let watchTimer: ReturnType<typeof setInterval> | null = null
let watchPaused = false
let ticking = false
let lastHash: bigint | null = null
let lastTextHash = ''
let lastDebugApp: string | null | undefined = undefined // 调试日志：仅前台 App 变化时记一次，避免刷屏
let previewBlockLogged = false // 调试日志：预览卡占用导致跳过只记一次，卡关掉后重置
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

/** 是否纸壳助手自己在前台：停在本应用页面时不该扫描自己的窗口（否则把已有日程当成新检测）。 */
function isOwnApp(frontApp: string | null): boolean {
  if (!frontApp) return false
  const f = frontApp.trim().toLowerCase()
  return [app.getName(), 'electron', '纸壳助手', 'eshell'].some((n) => n && f.includes(n.toLowerCase()))
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
    const {
      screenSenseKeywords,
      screenSenseExcludedApps,
      screenSenseAllowedApps,
      screenSenseKeepShots,
      screenSensePopup
    } = getSettings()
    // 截图前定前台 App：① 排除名单(硬隐私门) ② 不监控纸壳助手自己 ③ 进程级允许名单(只看 IM 等)
    const frontApp = await getFrontmostApp()
    const appChanged = frontApp !== lastDebugApp
    lastDebugApp = frontApp
    if (appChanged) debugEvent('frontapp', `前台应用：${frontApp ?? '(未知)'}`)
    if (screenSenseExcludedApps.length && isAppExcluded(frontApp, screenSenseExcludedApps)) {
      if (appChanged) debugEvent('skip', '在排除名单，跳过')
      return
    }
    if (isOwnApp(frontApp)) {
      if (appChanged) debugEvent('skip', '纸壳助手自己在前台，跳过')
      return
    }
    if (screenSenseAllowedApps.length && !isAppExcluded(frontApp, screenSenseAllowedApps)) {
      if (appChanged)
        debugEvent(
          'skip',
          frontApp ? `「${frontApp}」不在监控名单，跳过` : '前台应用检测失败，按名单跳过'
        )
      return
    }
    // 命中监控名单（进程级"检测到相关进程"）——调试面板据此确认进程门已放行
    if (appChanged && screenSenseAllowedApps.length)
      debugEvent('frontapp', `命中监控名单：${frontApp}，开始处理`)

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
    const text = await ocrTextForParse(png)
    if (!text) {
      debugEvent('ocr', 'OCR 未识别到文字')
      return
    }
    debugEvent('ocr', `OCR 完成：${text.length} 字`)
    const th = textHash(text)
    if (th === lastTextHash) return // 文本没变 → 静默跳过
    lastTextHash = th

    // 本地严格门：关键词 + 时间线索缺一不弹、不上云
    const local = detectLocalSchedule(text, screenSenseKeywords)
    if (!local) {
      debugEvent('detect', '本地未命中（无关键词或无明确时间）')
      return
    }
    debugEvent(
      'detect',
      `本地命中：「${local.title}」 ${local.isoTime ?? local.timeText} ${local.strong ? '[强]' : '[弱]'} 关键词:${local.hits.join('/')}`
    )

    const now = Date.now()
    for (const [k, exp] of cooldown) if (exp <= now) cooldown.delete(k) // 清理过期，避免 Map 无界增长
    const until = cooldown.get(th)
    if (until && until > now) {
      debugEvent('record', '同内容冷却中，跳过')
      return
    }
    cooldown.set(th, now + COOLDOWN_MS)

    // 被动留存 + 长期去重：跨状态按 标题+时间 去重；已记录过（待处理/已忽略/已加入）的内容不再重复抓取/弹窗
    const { detection, isNew } = addDetection({
      title: local.title,
      timeIso: local.isoTime,
      deadline: local.deadline,
      sourceText: text,
      hits: local.hits,
      app: frontApp
    })
    debugEvent('record', isNew ? '已记入「记忆」历史（新）' : '已存在，不重复抓取')
    if (!isNew) return

    // 截图持久化（#52/#53，opt-in）：趁 png 还在存加密临时缩略图，接受时落实
    if (screenSenseKeepShots && png) saveShotTempFromPng(th, png)

    // 少量主动：仅强信号 + 弹窗开关开 + 仍在同一 App（新鲜度门）才弹卡
    if (!local.strong || !screenSensePopup) {
      debugEvent('popup', '不弹卡（弱信号或弹窗关），留在记忆历史')
      return
    }
    if (frontApp && (await getFrontmostApp()) !== frontApp) {
      debugEvent('popup', '已切走 App，不弹')
      return
    }
    debugEvent('popup', `弹出检测卡：「${local.title}」`)
    showPreview({ localSuggestion: { ...local, sourceText: text, detectionId: detection.id } })
  } catch {
    // 持续监控全程静默：截图/OCR/解析/无 endpoint 等任何失败都不打扰
  } finally {
    if (png) void unlink(png).catch(() => {})
    ticking = false
  }
}

export function startWatch(intervalSec: number): void {
  stopWatch()
  watchTimer = setInterval(() => void watchTick(), Math.max(2, intervalSec) * 1000)
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
