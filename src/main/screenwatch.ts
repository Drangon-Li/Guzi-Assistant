import { unlink } from 'fs/promises'
import { captureScreenSilently, excerptOf, HINTS } from './capture'
import { ocrImage } from './ocr'
import { parseToItems } from './parser'
import { createSource, createTask, deleteSourceRow, getSettings, taskExists } from './db'
import { broadcast, showPreview } from './windows'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { matchKeywords } from '@shared/keywords'
import { pickBest } from '@shared/suggest'
import type { AddedInfo, ParsedItem } from '@shared/parsing'
import type { ParseSummary, ScanResult, TaskStatus } from '@shared/types'

function emptySummary(error: string | null): ParseSummary {
  return { sourceId: '', total: 0, related: 0, autoAdded: 0, duplicates: 0, error }
}

/** 扫描一次当前屏幕：截图 → 本地 OCR → 解析 → 选最优 → 右下角弹建议卡 */
export async function scanOnce(): Promise<ScanResult> {
  // 触发后立刻弹"正在扫描"加载卡，否则截图/OCR/解析这几秒里用户不知道 al1 在工作
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
  broadcast('al1:tasks-updated')
  return { candidate: 0, title: item.title, time, duplicate: false }
}

/** 跟随设置开关注册/注销扫描快捷键（启动时 + settings:save 时调用） */
export function applyScreenSenseSettings(): void {
  const { screenSenseEnabled, screenSenseHotkey } = getSettings()
  if (screenSenseEnabled) initScanHotkey(screenSenseHotkey, () => void scanOnce())
  else unregisterScanHotkey()
}
