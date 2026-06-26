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
  getProfile,
  getSettings,
  getSource,
  setDetectionStatus,
  findDuplicateTitle
} from './db'
import { broadcast, debugEvent, debugIsOpen, showPreview, isPreviewVisible } from './windows'
import { applyExternalPetSay, isPetVisible, setPetScanning } from './pet/controller'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { getFrontmostApp } from './frontapp'
import {
  saveShotTempFromPng,
  finalizeShot,
  deleteShot,
  listShotIds,
  sweepTempShots
} from './shotvault'
import { extract, unloadLocalModel, startIdleSweep, stopIdleSweep } from './local-model/extractor'
import { shouldEscalate } from '@shared/local-model-schema'
import { pickBestByTime, isAmbiguous } from '@shared/screen-foreground'
import { pickBest } from '@shared/suggest'
import { isAppExcluded } from '@shared/app-exclude'
import { looksLikeChat, clusterChatSpeakers, formatChatTranscript, type TextBox } from '@shared/chat-layout'
import { expiredShotIds } from '@shared/shot-retention'
import { dhash, hamming, bgraToGray, textHash } from '@shared/phash'
import type { AddedInfo, ParsedItem } from '@shared/parsing'
import type { LocalExtraction, ParseSummary, ScanResult, TaskStatus } from '@shared/types'

function emptySummary(error: string | null): ParseSummary {
  return { sourceId: '', total: 0, related: 0, autoAdded: 0, duplicates: 0, error }
}

/** 本地置信度低于此值（或模型自判 needsVlm）→ 自动上云 VLM 复核。 */
const CONF_MIN = 0.6
const FG_X_CUT = 0.18 // 升级裁前景图：去左侧栏/会话列表
const FG_Y_TOP = 0.025 // 去顶部菜单栏

/**
 * OCR 框 → 本地小模型精筛（前景过滤 + 日期锚定）→ 选最优；低置信/缺信息则自动上 VLM 复核：
 * 裁前景截图发 parse_vision（去侧栏，避免把列表/侧栏当任务），裁剪/升级失败回退本地结论。
 */
async function detectAndMaybeRefine(
  boxes: TextBox[],
  text: string,
  png: string
): Promise<{ extraction: LocalExtraction; item: ParsedItem; refined: boolean } | null> {
  const profile = getProfile()
  const selfNames = profile ? [profile.name, ...(profile.nicknames ?? [])].filter(Boolean) : []
  const items = await extract(boxes, selfNames)
  const best = pickBestByTime(items)
  if (!best) return null
  // 升级条件：本地置信不足/模型自判，或多 strong 候选日期打架(本地选错也高置信，靠 VLM 兜底)
  if (shouldEscalate(best, CONF_MIN) || isAmbiguous(items)) {
    try {
      const imageDataUrl = cropForegroundDataUrl(png)
      const refinedBest = pickBest(
        await parseToItems(
          imageDataUrl ? { imageDataUrl, hint: HINTS.screen_scan_vision } : { text, hint: HINTS.screen_scan }
        )
      )
      if (refinedBest) return { extraction: best, item: refinedBest, refined: true }
    } catch {
      // 升级失败（未登录/无档案/网络/裁剪失败）→ 回退本地结论
    }
  }
  return { extraction: best, item: buildLocalItem(best), refined: false }
}

/** 裁前景截图(去左侧栏/菜单栏)成 JPEG dataURL（供 VLM 升级，避免把侧栏/列表里别的会话当任务）；失败返回 null。 */
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

/** 扫描一次当前屏幕：截图 → 本地 OCR → 本地模型精筛（按需 VLM）→ 右下角弹建议卡 */
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

    const { screenSenseKeepShots } = getSettings()
    // png 保留到检测/升级裁剪之后再删（升级需原图裁前景），故包一层 try/finally
    try {
      const boxes = await ocrImageDetailed(png)
      const text = buildOcrText(boxes)
      // 截图持久化（#52/#53，opt-in）：趁 png 还在，按 textHash 存加密临时缩略图
      if (text && screenSenseKeepShots) saveShotTempFromPng(textHash(text), png)
      debugEvent('ocr', text ? `OCR 完成：${text.length} 字` : 'OCR 未识别到文字')
      if (!text) {
        showPreview({ error: '屏幕上没有识别到文字' }) // 灰色提示卡，3s 自动消失
        return { status: 'empty', message: '屏幕上没有识别到文字' }
      }
      debugEvent('ocr-text', `\n---OCR 原文---\n${text.slice(0, 4000)}\n---END---`) // 诊断：落盘当次 OCR 全文

      // 本地优先：本地小模型即时精筛（前景+日期锚定），低置信自动升级 VLM（裁前景图）
      const t0 = Date.now()
      const hit = await detectAndMaybeRefine(boxes, text, png)
      debugEvent('timing', `本地抽取耗时 ${Date.now() - t0}ms`)
      if (!hit) {
        debugEvent('detect', '本地模型未发现明确待办')
        // 永远给 AI 解析兜底：本地没抽到也弹卡，让用户能手动上云精解
        showPreview({ noLocalHit: { sourceText: text } })
        return { status: 'empty', message: '本地未发现日程，可点 AI 解析' }
      }
      const { extraction, item } = hit
      debugEvent(
        'detect',
        `命中：「${extraction.title}」 ${extraction.isoTime ?? '无时间'}${hit.refined ? ' [VLM]' : ''}`
      )
      const { detection } = addDetection({
        title: extraction.title,
        timeIso: extraction.isoTime,
        deadline: extraction.deadline,
        sourceText: text,
        hits: extraction.hits,
        app: null
      })
      showPreview({
        localSuggestion: { ...extraction, item, sourceText: text, detectionId: detection.id }
      })
      applyExternalPetSay('发现一个日程~', 'waiting')
      return { status: 'suggested', message: `检测到可能的日程：${extraction.title}` }
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
  const source = createSource({
    type: 'screen_scan',
    excerpt: excerptOf(sourceText),
    content: sourceText.slice(0, 20000),
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
  setPetScanning(true)
  const tc = Date.now()
  try {
    const items = await parseToItems({ text: sourceText, hint: HINTS.screen_scan })
    debugEvent('timing', `云端解析耗时 ${Date.now() - tc}ms`)
    const best = pickBest(items)
    debugEvent('cloud', best ? `云端解析完成：「${best.title}」` : '云端解析完成：未发现明确事项')
    if (!best) return null
    return { item: best, sourceText, hits: [] }
  } finally {
    setPetScanning(false)
  }
}

/** 本地抽取 → ParsedItem。同意本地候选/历史共用。 */
function buildLocalItem(e: LocalExtraction): ParsedItem {
  return {
    title: e.title,
    item_type: 'other',
    belongs_to_user: e.belongsToUser,
    belonging_reason: '本地模型识别',
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

/** 同意本地候选:直接入库（不上云）；item 已含本地或 VLM 精修结果。带 detectionId 则标记历史为已加入。 */
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
      needsVlm: false,
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
// 流水线：pHash 变化门 → OCR → 文本去重/冷却 → 本地模型精筛（按需 VLM）→ 建议卡。截图用完即弃、只文字上云。
// pHash 算法与参数沿用 volcengine/MineContext（imagehash.dhash hash_size=8 + 异或 popcount 汉明距离；
// capture_interval 默认 5s、similarity_hash_threshold 默认 2），其为 Python+imagehash，此处用 TS 等价落地（见 @shared/phash）。

const PHASH_THRESHOLD = 2 // 汉明距离 ≤ 此值视为"屏幕没变" → 跳过 OCR/模型（MineContext 实测默认）
const COOLDOWN_MS = 10 * 60 * 1000 // 同一内容命中后冷却，避免反复弹卡
const IDLE_UNLOAD_MS = 10 * 60 * 1000 // 模型空闲超此时长自动卸载释放内存

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
    const { screenSenseExcludedApps, screenSenseKeepShots, screenSensePopup } = getSettings()
    // 截图前定前台 App：① 排除名单(硬隐私门) ② 不监控纸壳助手自己。全屏感知，不再按进程名单过滤。
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
    const text = buildOcrText(boxes)
    if (!text) {
      debugEvent('ocr', 'OCR 未识别到文字')
      return
    }
    debugEvent('ocr', `OCR 完成：${text.length} 字`)
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

    // 本地小模型精筛（前景+日期锚定）+ 低置信自动升级 VLM（裁前景图）
    const hit = await detectAndMaybeRefine(boxes, text, png)
    if (!hit) {
      debugEvent('detect', '本地模型未发现明确待办')
      return
    }
    const { extraction } = hit
    debugEvent(
      'detect',
      `命中：「${extraction.title}」 ${extraction.isoTime ?? '无时间'} ${extraction.strong ? '[强]' : '[弱]'}${hit.refined ? ' [VLM]' : ''}`
    )

    // 被动留存 + 长期去重：跨状态按 标题+时间 去重；已记录过（待处理/已忽略/已加入）的内容不再重复抓取/弹窗
    const { detection, isNew } = addDetection({
      title: extraction.title,
      timeIso: extraction.isoTime,
      deadline: extraction.deadline,
      sourceText: text,
      hits: extraction.hits,
      app: frontApp
    })
    debugEvent('record', isNew ? '已记入「记忆」历史（新）' : '已存在，不重复抓取')
    if (!isNew) return

    // 截图持久化（#52/#53，opt-in）：趁 png 还在存加密临时缩略图，接受时落实
    if (screenSenseKeepShots && png) saveShotTempFromPng(th, png)

    // 少量主动：仅强信号 + 弹窗开关开 + 仍在同一 App（新鲜度门）才弹卡
    if (!extraction.strong || !screenSensePopup) {
      debugEvent('popup', '不弹卡（弱信号或弹窗关），留在记忆历史')
      return
    }
    if (frontApp && (await getFrontmostApp()) !== frontApp) {
      debugEvent('popup', '已切走 App，不弹')
      return
    }
    debugEvent('popup', `弹出检测卡：「${extraction.title}」`)
    showPreview({
      localSuggestion: { ...extraction, item: hit.item, sourceText: text, detectionId: detection.id }
    })
    applyExternalPetSay('发现一个日程~', 'waiting')
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

/** 跟随设置开关注册/注销扫描快捷键 + 启停持续监控 + 模型生命周期（启动时 + settings:save 时调用） */
export function applyScreenSenseSettings(): void {
  const { screenSenseEnabled, screenSenseLocalModel, screenSenseHotkey, screenSenseContinuous, screenSenseIntervalSec } =
    getSettings()
  const on = screenSenseEnabled && screenSenseLocalModel
  if (on) initScanHotkey(screenSenseHotkey, () => void scanOnce())
  else unregisterScanHotkey()
  if (on && screenSenseContinuous) startWatch(screenSenseIntervalSec)
  else stopWatch()
  if (on) {
    startIdleSweep(IDLE_UNLOAD_MS) // 模型按需 lazy load；空闲自动卸载
  } else {
    stopIdleSweep()
    void unloadLocalModel() // 关功能即释放内存
  }
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
