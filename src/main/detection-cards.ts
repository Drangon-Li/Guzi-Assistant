// 检测卡与接受流：屏幕感知与剪贴板自动捕获共用的「候选 → 记忆历史 → 弹卡 → 入库」内核。
import {
  addDetection,
  cleanupStaleDetections,
  createSource,
  deleteSourceRow,
  findDuplicateTitle,
  getDetection,
  listPendingDetections,
  setDetectionStatus
} from './db'
import { detectionQueueDecision, looksCompleted } from '@shared/detection-gate'
import { createTaskFromItem, scheduledStatus } from './task-ingest'
import { excerptOf } from './capture'
import { broadcast, debugEvent, showPreview } from './windows'
import { finalizeShot } from './shotvault'
import { textHash } from '@shared/phash'
import type { AddedInfo, ParsedItem } from '@shared/parsing'
import type { LocalExtraction } from '@shared/types'

export interface DetectHit {
  extraction: LocalExtraction
  item: ParsedItem
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
export interface DetectedCard {
  suggestion: Record<string, unknown> // localSuggestion 载荷（卡显示 + 接受）
  detectionId: string
}

/** 把云端候选记进「记忆」历史，并挑出该弹卡的那些。屏幕感知与剪贴板自动捕获共用。
 *  onNewDetection 供屏幕路径存证据图；剪贴板路径没有截图，不传即可。
 *  manual=true（手动扫描）：用户主动触发，全部候选都出卡，不做 isNew/强弱信号门控。 */
export function buildDetectionCards(input: {
  hits: DetectHit[]
  sourceText: string
  app: string | null
  popup: boolean
  manual?: boolean
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
    // 入队门槛（#128）：模型说别记的、明确是别人的、没时间又没把握的，存档留痕但不占待确认队列。
    // 手动扫描是用户主动问「现在屏幕上有什么」，照样出卡，只是入库状态仍按门槛判。
    const decision = detectionQueueDecision(item, extraction.strong)
    // 被动留存 + 长期去重：跨状态按 标题+时间 去重；已记录过的内容不再重复抓取/弹窗
    const { detection, isNew } = addDetection({
      title: extraction.title,
      timeIso: extraction.isoTime,
      deadline: extraction.deadline,
      sourceText: input.sourceText,
      item,
      hits: extraction.hits,
      app: input.app,
      status: decision === 'archive' ? 'archived' : 'new'
    })
    if (!isNew && !input.manual) {
      debugEvent('record', '已存在，不重复抓取')
      continue
    }
    if (isNew) {
      debugEvent(
        'record',
        decision === 'archive'
          ? `已存档，不进待确认队列（${item.suggested_action}/${item.confidence}）`
          : '已记入「记忆」历史（新）'
      )
      input.onNewDetection?.()
    }
    if (!input.manual && decision === 'archive') continue
    if (!input.manual && ((!extraction.strong && !listMode) || !input.popup)) {
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
  const task = createTaskFromItem(source.id, item, scheduledStatus(item), true)
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
  cleanupStaleDetections()
  const d = getDetection(id)
  if (!d) return null
  const info = acceptSuggestion({
    item: d.item ?? buildLocalItem({
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

/**
 * 完成即撤（#128）：屏幕上出现「这条已经做完」的迹象时自动归档，不留着等用户手动点忽略。
 * 只扫仍在待确认的那些，靠标题锚点 + 同行完成标记判断——宁可漏撤也不误撤，
 * 撤错了用户会丢掉一件真事，漏撤只是多一条待确认。
 */
export function sweepCompletedDetections(screenText: string): number {
  if (!screenText.trim()) return 0
  let swept = 0
  for (const d of listPendingDetections()) {
    if (!looksCompleted(d.title, screenText)) continue
    setDetectionStatus(d.id, 'archived')
    debugEvent('record', `屏幕显示已完成，自动撤回：「${d.title}」`)
    swept += 1
  }
  return swept
}
