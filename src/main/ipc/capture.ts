// IPC：捕获与屏幕识别：剪贴板/文件/截图、预览卡、快捷提问条、检测候选与建议。
// 通道清单以 src/shared/ipc-channels.ts 为准；这里只是按领域归位的注册。
import { ipcMain } from './register'
import { getProfile, addDetectionNote, cleanupStaleDetections, listPendingDetections, saveProfile } from '../db'
import { learnNotMine } from '@shared/belonging-learn'
import {
  cancelPending,
  clearPendings,
  readClipboardPending,
  submitFiles,
  submitPending,
  submitScreenshot,
  takeScreenshot
} from '../capture'
import type { ParsedItem } from '@shared/parsing'
import { scanOnce, screenActivityStatus } from '../screenwatch'
import { acceptDetection, acceptLocal, acceptLocalBatch, acceptSuggestion, dismissDetection } from '../detection-cards'
import { hidePreview, resizePreview, showPreview } from '../windows'
import { hideQuickBar, resizeQuickBar } from '../quickbar'
import { trackExitWork, isExitPreparing } from '../exit-lifecycle'
import {
  assertContentEpoch,
  captureContentEpoch,
  isContentEpochCurrent,
  isContentResetting
} from '../content-lifecycle'

/** 快捷键 / 托盘共用的剪切板捕获入口 */
export function triggerClipboardCapture(): void {
  if (isContentResetting() || isExitPreparing()) return
  showPreview(readClipboardPending())
}

/** 提交屏幕截图：交互框选截图 → 送解析。供全局快捷键调用。 */
export function triggerScreenshotCapture(): void {
  if (isContentResetting() || isExitPreparing()) return
  const epoch = captureContentEpoch()
  void trackExitWork((async () => {
    const dataUrl = await takeScreenshot()
    assertContentEpoch(epoch)
    if (dataUrl) await submitScreenshot(dataUrl)
  })()).catch((error) => {
    if (isContentEpochCurrent(epoch)) showPreview({ error: error instanceof Error ? error.message : String(error) })
  })
}

export function registerCaptureIpc(): void {
  ipcMain.handle('capture:clipboard', () => triggerClipboardCapture())
  ipcMain.handle('capture:files', (_e, paths: string[]) => submitFiles(paths))
  ipcMain.handle('capture:screenshot', async () => {
    const dataUrl = await takeScreenshot()
    if (!dataUrl) return null
    return submitScreenshot(dataUrl)
  })

  ipcMain.handle('preview:submit', (_e, captureId: string) => submitPending(captureId))
  ipcMain.handle('preview:cancel', (_e, captureId: string) => {
    cancelPending(captureId)
    hidePreview()
  })
  ipcMain.handle('preview:hide', () => {
    clearPendings()
    hidePreview()
  })
  ipcMain.handle('preview:resize', (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) resizePreview(height)
  })
  ipcMain.handle('quickbar:hide', () => hideQuickBar())
  ipcMain.handle('quickbar:resize', (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) resizeQuickBar(height)
  })
  ipcMain.handle('screen:scan', () => scanOnce())
  ipcMain.handle('screen:activity-status', () => screenActivityStatus())
  ipcMain.handle('suggestion:accept', (_e, payload: { item: ParsedItem; sourceText: string }) =>
    acceptSuggestion(payload)
  )
  ipcMain.handle(
    'suggestion:accept-local',
    (_e, p: { item: ParsedItem; sourceText: string; detectionId?: string }) => acceptLocal(p)
  )
  ipcMain.handle(
    'suggestion:accept-batch',
    (_e, p: { entries: { item: ParsedItem; sourceText: string; detectionId?: string }[] }) =>
      acceptLocalBatch(p)
  )
  // 检测回看（日程页「待确认」区）：错过/自动隐藏的弹卡在这里兜底处理；拉取前先清过期项。
  // 只取 status='new'——没过入队门槛的候选也在同一张表里（archived，供去重），
  // 若按「最近 N 条」不分状态地取，它们会把真正待确认的挤出窗口（#128）。
  ipcMain.handle('detections:list', () => {
    cleanupStaleDetections()
    return listPendingDetections()
  })
  ipcMain.handle('detections:accept', (_e, id: string) => acceptDetection(id))
  ipcMain.handle('detections:dismiss', (_e, id: string) => dismissDetection(id))
  ipcMain.handle(
    'detections:note',
    (_e, p: { detectionId: string | null; title: string; note: string }) => {
      const note = p.note.trim()
      if (!note) return
      addDetectionNote(p.detectionId, p.title, note)
      if (/不是我|别人|他的|她的|同事|其他人/.test(note)) {
        const profile = getProfile()
        if (profile) {
          const next = learnNotMine(profile, `${p.title} ${note}`)
          if (next !== profile) saveProfile(next)
        }
      }
      if (p.detectionId) dismissDetection(p.detectionId)
    }
  )
}
