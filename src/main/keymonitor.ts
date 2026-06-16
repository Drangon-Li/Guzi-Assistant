import { unlink } from 'fs/promises'
import { appendFileSync } from 'fs'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { captureScreenSilently } from './capture'
import { ocrImageDetailed } from './ocr'
import { createSource } from './db'
import { shouldRecord, noteRecorded, newCaptureState } from '@shared/interaction-capture'

/**
 * #路线图 2a/2b：监控敏感按键（回车），用户「提交」时（敲回车）把当前屏幕内容作为**被动记忆来源**记下。
 * 全局键钩子（uiohook，N-API 跨平台/Win 优先）只做触发；内容用既有截屏 + OCR（与屏幕感知同管线），
 * 经 shouldRecord 决策（去重/护凭据/滤短）后落为来源，**不立即解析** —— 留给「整理归档」归纳成记忆/待办。
 * 这正是「被动捕获流 → 记忆」缺的那一环（被动流，非每条即解析）。
 */
let running = false
let capturing = false
const state = newCaptureState()

const DBG = process.env.ESHELL_KEYMON_DEBUG
const dbg = (...a: unknown[]): void => {
  if (!DBG) return
  try {
    appendFileSync(DBG, `[keymon ${new Date().toISOString()}] ${a.map(String).join(' ')}\n`)
  } catch {
    /* ignore */
  }
}

async function captureOnEnter(): Promise<void> {
  if (capturing) return // 上一次还在处理就跳过，避免连按回车堆叠
  capturing = true
  let png: string | null = null
  try {
    png = await captureScreenSilently()
    dbg('captured png:', png)
    if (!png) return
    const boxes = await ocrImageDetailed(png)
    const text = boxes
      .map((b) => b.text)
      .join('\n')
      .trim()
    dbg('ocr len:', text.length, '|', text.slice(0, 80))
    if (!text) return
    const now = Date.now()
    const d = shouldRecord(text, state, now)
    dbg('decision:', d.record, d.reason)
    if (!d.record) return // 太短/疑似凭据/近期重复 → 不记
    noteRecorded(text, state, now)
    createSource({
      type: 'screen_scan',
      excerpt: text.slice(0, 200),
      content: text.slice(0, 20000),
      filePath: null
    })
    dbg('source created')
  } catch (e) {
    dbg('ERR', e instanceof Error ? e.message : String(e))
  } finally {
    if (png) void unlink(png).catch(() => {})
    capturing = false
  }
}

function onKeydown(e: { keycode: number }): void {
  if (e.keycode === UiohookKey.Enter) {
    dbg('Enter caught')
    void captureOnEnter()
  }
}

export function startKeyMonitor(): void {
  if (running) return
  uIOhook.on('keydown', onKeydown)
  uIOhook.start()
  running = true
  dbg('started')
}

export function stopKeyMonitor(): void {
  if (!running) return
  uIOhook.off('keydown', onKeydown)
  try {
    uIOhook.stop()
  } catch {
    /* stop 失败忽略 */
  }
  running = false
}

export function isKeyMonitorRunning(): boolean {
  return running
}
