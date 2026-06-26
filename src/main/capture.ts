import { app, clipboard, nativeImage, screen } from 'electron'
import type { NativeImage } from 'electron'
import { execFile } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import { detectSensitive } from './sensitive'
import { createSource, createTask, deleteSourceRow, getProfile, taskExists } from './db'
import { parseToItems, type ParsedItem } from './parser'
import { broadcast, showPreview } from './windows'
import { applyExternalPetReaction } from './pet/controller'
import type { ParseSummary, PendingCapture, SourceType, TaskStatus } from '@shared/types'

interface PendingPayload {
  type: SourceType
  text?: string
  imageDataUrl?: string
  filePath?: string
}

const pendings = new Map<string, PendingPayload>()

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
const TEXT_EXTS = ['.txt', '.md', '.eml', '.csv', '.log']

export function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function shrink(img: NativeImage, maxWidth: number): NativeImage {
  return img.getSize().width > maxWidth ? img.resize({ width: maxWidth }) : img
}

/** JPEG 比 PNG dataURL 小一个量级，截图入库/上传都用它 */
export function toJpegDataUrl(img: NativeImage, maxWidth: number): string {
  return `data:image/jpeg;base64,${shrink(img, maxWidth).toJPEG(80).toString('base64')}`
}

function register(payload: PendingPayload, view: Omit<PendingCapture, 'captureId'>): PendingCapture {
  // 预览卡一次只显示一条，旧的未提交内容直接作废，避免 Map 泄漏
  pendings.clear()
  const captureId = randomUUID()
  pendings.set(captureId, payload)
  return { captureId, ...view }
}

// ---------- 读取剪切板（仅在用户触发时调用，CAP-04） ----------

export function readClipboardPending(): PendingCapture | { error: string } {
  const img = clipboard.readImage()
  if (!img.isEmpty()) {
    return register(
      { type: 'clipboard_image', imageDataUrl: toJpegDataUrl(img, 1600) },
      {
        type: 'clipboard_image',
        kind: 'image',
        excerpt: '[剪切板图片]',
        charCount: 0,
        fileName: null,
        thumbnailDataUrl: toJpegDataUrl(img, 320),
        sensitiveHits: []
      }
    )
  }

  const fileUrl = process.platform === 'darwin' ? clipboard.read('public.file-url') : ''
  if (fileUrl.startsWith('file://')) {
    const filePath = decodeURIComponent(fileUrl.replace('file://', ''))
    return register(
      { type: 'clipboard_file', filePath },
      {
        type: 'clipboard_file',
        kind: 'file',
        excerpt: `文件：${basename(filePath)}`,
        charCount: 0,
        fileName: basename(filePath),
        thumbnailDataUrl: null,
        sensitiveHits: []
      }
    )
  }

  const text = clipboard.readText().trim()
  if (text) {
    return register(
      { type: 'clipboard_text', text },
      {
        type: 'clipboard_text',
        kind: 'text',
        excerpt: excerptOf(text),
        charCount: text.length,
        fileName: null,
        thumbnailDataUrl: null,
        sensitiveHits: detectSensitive(text)
      }
    )
  }
  return { error: '剪切板为空，请先复制内容' }
}

export function cancelPending(captureId: string): void {
  pendings.delete(captureId)
}

/** 预览窗隐藏时调用：未提交的内容一律作废 */
export function clearPendings(): void {
  pendings.clear()
}

// ---------- 截图（macOS screencapture 框选） ----------

export async function takeScreenshot(): Promise<string | null> {
  const file = join(app.getPath('temp'), `eshell-shot-${Date.now()}.png`)
  await new Promise<void>((resolve, reject) => {
    execFile('screencapture', ['-i', '-x', file], (err) => (err ? reject(err) : resolve()))
  })
  if (!existsSync(file)) return null // 用户按 Esc 取消了框选
  try {
    return toJpegDataUrl(nativeImage.createFromPath(file), 1600)
  } finally {
    // 即使 JPEG 编码抛错也要删掉临时 PNG，避免残留 temp 目录
    if (existsSync(file)) unlinkSync(file)
  }
}

/** 静默全屏截图（无交互、无快门声），返回临时 png 路径；失败返回 null。调用方 OCR 后须自行删除 */
export async function captureScreenSilently(): Promise<string | null> {
  const file = join(app.getPath('temp'), `eshell-screen-${Date.now()}.png`)
  // 只截「活动屏」（光标所在显示器）：多显示器下 `screencapture -x <file>` 只会截主屏，
  // 用 -R<x,y,w,h> 截活动屏的矩形区域，既覆盖外接屏，又省一半开销。
  const args = ['-x']
  try {
    const { x, y, width, height } = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint()
    ).bounds
    args.push('-R', `${x},${y},${width},${height}`)
  } catch {
    /* 拿不到显示器信息 → 退回整屏（主屏） */
  }
  args.push(file)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('screencapture', args, (err) => (err ? reject(err) : resolve()))
    })
  } catch {
    return null
  }
  return existsSync(file) ? file : null
}

// ---------- 文件文本抽取 ----------

async function extractFromFile(filePath: string): Promise<{ text?: string; imageDataUrl?: string }> {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_EXTS.includes(ext)) {
    return { imageDataUrl: toJpegDataUrl(nativeImage.createFromPath(filePath), 1600) }
  }
  if (TEXT_EXTS.includes(ext)) {
    return { text: readFileSync(filePath, 'utf-8').slice(0, 20000) }
  }
  if (ext === '.pdf') {
    const { text } = await pdfParse(readFileSync(filePath))
    if (!text.trim()) throw new Error('PDF 中没有可抽取的文本（可能是扫描件），请改用截图提交')
    return { text: text.slice(0, 20000) }
  }
  if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ path: filePath })
    return { text: value.slice(0, 20000) }
  }
  throw new Error(`暂不支持 ${ext || '该'} 格式，请使用图片、PDF、docx、txt`)
}

/** 桌宠拖入文件 → 抽纯文本（txt/md/pdf/docx）；图片或无文本返回 null（交回现有捕获管线）。 */
export async function extractPetDropText(filePath: string): Promise<{ name: string; text: string } | null> {
  try {
    const r = await extractFromFile(filePath)
    if (r.text && r.text.trim()) return { name: basename(filePath), text: r.text }
    return null
  } catch {
    return null
  }
}

// ---------- 解析入库 ----------

export const HINTS: Record<string, string> = {
  clipboard_text: '以下是用户从剪切板提交的文本（通常来自聊天、通知或邮件），请提取其中的行动项。',
  clipboard_image: '用户从剪切板提交了一张图片（通常是聊天或通知截图），请识别图中文字并提取行动项。',
  clipboard_file: '以下是用户提交的文件内容，请提取其中的行动项。',
  screenshot: '用户提交了一张屏幕截图（通常是聊天、群通知、网页或课程平台），请识别图中文字并提取行动项。',
  file: '以下是用户拖拽提交的文件内容，请提取其中的行动项。',
  text_input: '以下是用户粘贴/输入的文本，请提取其中的行动项。',
  feishu: '以下是用户从飞书转发给 纸壳助手 机器人的消息（通常是群通知、聊天记录或截图），请提取其中的行动项。',
  screen_scan:
    '以下是从用户屏幕上 OCR 识别出的文字，可能混有菜单、按钮、侧边栏等无关界面文字。请只提取明确的、与用户本人相关的行动项；信息不足或无法确认时不要硬凑，宁可一个都不提取。',
  screen_scan_vision:
    '这是用户屏幕当前阅读区域的截图（已裁去左侧会话/邮件列表与菜单栏）。请只提取图中、与用户本人相关、有明确时间的行动项。聊天里的随口建议/讨论/疑问、纯历史新闻、已读回执都不是待办。"选课/报名 时间：A 至 B"是"在 B 之前完成"的截止任务：due_time 填结束日 B、start_time 留 null。信息不足或拿不准时宁可一个都不提取。'
}

function createTasksFromItems(
  sourceId: string,
  items: ParsedItem[]
): { related: number; autoAdded: number; duplicates: number } {
  const profile = getProfile()
  const mode = profile?.confirmMode ?? 'standard'
  let related = 0
  let autoAdded = 0
  let duplicates = 0
  for (const it of items) {
    if (it.belongs_to_user === 'no') continue // 分配给别人的任务不入库（文档 4.3 多人分配）
    if (taskExists(it.title, it.due_time)) {
      duplicates++ // 同一通知被重复提交（群转发两遍、手滑双击）很常见，静默生成重复任务最伤信任
      continue
    }
    related++
    let status: TaskStatus = 'pending'
    if (mode === 'aggressive' && it.belongs_to_user === 'yes' && it.confidence >= 0.85 && it.suggested_action === 'add') {
      status = it.due_time || it.start_time ? 'scheduled' : 'not_started'
      autoAdded++
    }
    createTask({
      sourceId,
      title: it.title,
      itemType: it.item_type,
      belongsToUser: it.belongs_to_user,
      belongingReason: it.belonging_reason,
      userRole: it.user_role,
      startTime: it.start_time,
      dueTime: it.due_time,
      location: it.location,
      priority: it.priority,
      confidence: it.confidence,
      suggestedAction: it.suggested_action,
      evidence: it.evidence,
      notes: it.notes,
      duplicateOf: it.duplicate_of,
      status,
      feedback: null
    })
  }
  return { related, autoAdded, duplicates }
}

async function parseAndStore(payload: PendingPayload): Promise<ParseSummary> {
  let source: ReturnType<typeof createSource> | null = null
  try {
    let text = payload.text
    let imageDataUrl = payload.imageDataUrl
    // 文件抽取失败（不支持的格式/文件已删除/扫描件 PDF）也要走到 error summary，不能让 IPC reject
    if (payload.filePath) {
      const extracted = await extractFromFile(payload.filePath)
      text = extracted.text
      imageDataUrl = extracted.imageDataUrl
    }

    source = createSource({
      type: payload.type,
      excerpt: text ? excerptOf(text) : payload.filePath ? `文件：${basename(payload.filePath)}` : '[图片]',
      content: text ?? imageDataUrl ?? null,
      filePath: payload.filePath ?? null
    })

    const items = await parseToItems({ text, imageDataUrl, hint: HINTS[payload.type] ?? HINTS.text_input })
    const { related, autoAdded, duplicates } = createTasksFromItems(source.id, items)
    // 没有任何任务引用的来源在 UI 上不可见也删不掉，不留库
    if (related === 0) deleteSourceRow(source.id)
    broadcast('eshell:tasks-updated')
    return { sourceId: related ? source.id : '', total: items.length, related, autoAdded, duplicates, error: null }
  } catch (e) {
    // 解析失败的来源没有任何任务引用，UI 上不可见也删不掉，必须当场清理
    if (source) deleteSourceRow(source.id)
    return {
      sourceId: '',
      total: 0,
      related: 0,
      autoAdded: 0,
      duplicates: 0,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export async function submitPending(captureId: string): Promise<ParseSummary> {
  const payload = pendings.get(captureId)
  if (!payload)
    return {
      sourceId: '',
      total: 0,
      related: 0,
      autoAdded: 0,
      duplicates: 0,
      error: '提交内容已失效，请重新捕获'
    }
  pendings.delete(captureId)
  return parseAndStore(payload)
}

export async function submitScreenshot(dataUrl: string): Promise<ParseSummary> {
  return parseAndStore({ type: 'screenshot', imageDataUrl: dataUrl })
}

/** 飞书机器人收到的私聊消息 */
export async function submitFeishu(input: {
  text?: string
  imageDataUrl?: string
}): Promise<ParseSummary> {
  return parseAndStore({ type: 'feishu', ...input })
}

/** 托盘拖拽 / 右键快速操作的入口：用预览卡反馈进度和结果 */
export async function submitExternalFiles(paths: string[]): Promise<void> {
  showPreview({
    busy: paths.length === 1 ? `正在解析 ${basename(paths[0])}…` : `正在解析 ${paths.length} 个文件…`
  })
  const results = await submitFiles(paths)
  const merged: ParseSummary = {
    sourceId: '',
    total: results.reduce((n, r) => n + r.total, 0),
    related: results.reduce((n, r) => n + r.related, 0),
    autoAdded: results.reduce((n, r) => n + r.autoAdded, 0),
    duplicates: results.reduce((n, r) => n + r.duplicates, 0),
    error: null
  }
  const errors = results.filter((r) => r.error)
  if (errors.length && !merged.related && !merged.duplicates) merged.error = errors[0].error!
  showPreview({ summary: merged })
  if (merged.autoAdded > 0 || merged.related > 0) applyExternalPetReaction('success')
}

/** 单次提交文件数上限：每个文件一次解析调用（最长 120s），无上限会耗尽 API 配额并长时间占连接 */
const MAX_FILES_PER_SUBMIT = 20

export async function submitFiles(paths: string[]): Promise<ParseSummary[]> {
  const results: ParseSummary[] = []
  const capped = paths.slice(0, MAX_FILES_PER_SUBMIT)
  for (const p of capped) {
    try {
      results.push(await parseAndStore({ type: 'file', filePath: p }))
    } catch (e) {
      results.push({
        sourceId: '',
        total: 0,
        related: 0,
        autoAdded: 0,
        duplicates: 0,
        error: `${basename(p)}：${e instanceof Error ? e.message : String(e)}`
      })
    }
  }
  if (paths.length > MAX_FILES_PER_SUBMIT) {
    results.push({
      sourceId: '',
      total: 0,
      related: 0,
      autoAdded: 0,
      duplicates: 0,
      error: `一次最多处理 ${MAX_FILES_PER_SUBMIT} 个文件，已跳过其余 ${paths.length - MAX_FILES_PER_SUBMIT} 个`
    })
  }
  return results
}
