import { unlink } from 'fs/promises'
import { nativeImage } from 'electron'
import { captureScreenSilently, excerptOf, HINTS } from './capture'
import { ocrImage } from './ocr'
import { parseToItems } from './parser'
import { createSource, createTask, deleteSourceRow, getSettings, taskExists } from './db'
import { broadcast, showPreview, isPreviewVisible } from './windows'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { getFrontmostApp } from './frontapp'
import { matchKeywords } from '@shared/keywords'
import { pickBest } from '@shared/suggest'
import { isAppExcluded } from '@shared/app-exclude'
import { dhash, hamming, bgraToGray, textHash } from '@shared/phash'
import type { AddedInfo, ParsedItem } from '@shared/parsing'
import type { ParseSummary, ScanResult, TaskStatus } from '@shared/types'

function emptySummary(error: string | null): ParseSummary {
  return { sourceId: '', total: 0, related: 0, autoAdded: 0, duplicates: 0, error }
}

/** 扫描一次当前屏幕：截图 → 本地 OCR → 解析 → 选最优 → 右下角弹建议卡 */
export async function scanOnce(): Promise<ScanResult> {
  // 触发后立刻弹"正在扫描"加载卡，否则截图/OCR/解析这几秒里用户不知道 纸壳助手 在工作
  showPreview({ busy: '正在扫描屏幕…' })
  try {
    const png = await captureScreenSilently()
    if (!png) {
      const message = '截图失败，请检查屏幕录制权限'
      showPreview({ summary: emptySummary(message) }) // 红色错误卡，手动关闭
      return { status: 'error', message }
    }

    let text: string
    try {
      text = await ocrImage(png)
    } finally {
      void unlink(png).catch(() => {}) // 截图用完即弃
    }
    if (!text) {
      showPreview({ error: '屏幕上没有识别到文字' }) // 灰色提示卡，3s 自动消失
      return { status: 'empty', message: '屏幕上没有识别到文字' }
    }

    showPreview({ busy: '正在分析屏幕内容…' })
    const { screenSenseKeywords } = getSettings()
    const hits = matchKeywords(text, screenSenseKeywords)

    const items = await parseToItems({ text, hint: HINTS.screen_scan })
    const best = pickBest(items)
    if (!best) {
      showPreview({ error: '未发现明确的待办事项' })
      return { status: 'empty', message: '未发现明确的待办事项' }
    }

    showPreview({ suggestion: { item: best, sourceText: text, hits } })
    return { status: 'suggested', message: `发现一条可能的待办：${best.title}` }
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
  broadcast('eshell:tasks-updated')
  return { candidate: 0, title: item.title, time, duplicate: false }
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

/** 一轮静默监控；全程不打扰用户，只有真发现待办才弹建议卡 */
async function watchTick(): Promise<void> {
  if (ticking || watchPaused) return
  if (isPreviewVisible()) return // 别覆盖用户正在看的卡
  ticking = true
  let png: string | null = null
  try {
    const { screenSenseKeywords, screenSenseExcludedApps } = getSettings()
    // 隐私门：敏感 App（密码/银行等）在前台时连截图都不做（在 capture 之前判断）
    if (screenSenseExcludedApps.length && isAppExcluded(await getFrontmostApp(), screenSenseExcludedApps))
      return

    png = await captureScreenSilently()
    if (!png) return
    const hash = await pHashOfPng(png)
    if (lastHash !== null && hamming(hash, lastHash) <= PHASH_THRESHOLD) return // 屏幕没变 → 不 OCR、不上云
    lastHash = hash

    const text = await ocrImage(png)
    if (!text) return
    const th = textHash(text)
    if (th === lastTextHash) return // 文本没变 → 跳过
    lastTextHash = th

    const hits = matchKeywords(text, screenSenseKeywords)
    if (!hits.length) return // 相关性门：不含关键词不上云

    const now = Date.now()
    for (const [k, exp] of cooldown) if (exp <= now) cooldown.delete(k) // 清理过期，避免 Map 无界增长
    const until = cooldown.get(th)
    if (until && until > now) return // 同内容冷却中

    const items = await parseToItems({ text, hint: HINTS.screen_scan })
    const best = pickBest(items)
    if (!best) return
    cooldown.set(th, now + COOLDOWN_MS)
    showPreview({ suggestion: { item: best, sourceText: text, hits } })
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
}
