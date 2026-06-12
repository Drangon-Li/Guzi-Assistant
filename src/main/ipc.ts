import { ipcMain, systemPreferences } from 'electron'
import {
  bulkUpdateStatus,
  deleteSourceContent,
  getProfile,
  getSettings,
  getSource,
  listTasks,
  saveProfile,
  saveSettings,
  updateTask,
  wipeAll
} from './db'
import {
  cancelPending,
  clearPendings,
  readClipboardPending,
  submitFiles,
  submitPending,
  submitScreenshot,
  submitText,
  takeScreenshot
} from './capture'
import { setHotkey } from './hotkey'
import { installQuickAction, quickActionInstalled } from './quickaction'
import { broadcast, focusMain, hidePreview, showPreview } from './windows'
import type { AppSettings, PermissionStatus, Profile, TaskRecord, TaskStatus } from '@shared/types'

const STATUSES: TaskStatus[] = [
  'pending',
  'not_started',
  'scheduled',
  'in_progress',
  'done',
  'overdue',
  'ignored'
]

/** 快捷键 / 托盘共用的剪切板捕获入口 */
export function triggerClipboardCapture(): void {
  showPreview(readClipboardPending())
}

export function registerIpc(): void {
  ipcMain.handle('profile:get', () => getProfile())
  ipcMain.handle('profile:save', (_e, p: Profile) => saveProfile(p))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    let ok = true
    // 快捷键先注册成功再落库，避免把无效组合持久化导致下次启动无快捷键
    if (patch.hotkey !== undefined) {
      ok = setHotkey(patch.hotkey)
      if (!ok) delete patch.hotkey
    }
    saveSettings(patch)
    broadcast('al1:settings-updated')
    return ok
  })

  ipcMain.handle('capture:clipboard', () => triggerClipboardCapture())
  ipcMain.handle('capture:text', (_e, text: string) => submitText(text))
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

  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:update', (_e, id: string, patch: Partial<TaskRecord>) => {
    if (patch.status && !STATUSES.includes(patch.status)) return
    updateTask(id, patch)
    broadcast('al1:tasks-updated')
  })
  ipcMain.handle('tasks:bulk', (_e, ids: string[], status: TaskStatus) => {
    if (!STATUSES.includes(status)) return
    bulkUpdateStatus(ids, status)
    broadcast('al1:tasks-updated')
  })

  ipcMain.handle('source:get', (_e, id: string) => getSource(id))
  ipcMain.handle('source:delete', (_e, id: string) => {
    deleteSourceContent(id)
    broadcast('al1:tasks-updated')
  })

  ipcMain.handle('data:wipe', () => {
    wipeAll()
    broadcast('al1:tasks-updated')
  })

  ipcMain.handle('permissions:get', (): PermissionStatus => {
    const settings = getSettings()
    return {
      screen:
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
      apiConfigured: !!(settings.apiBase && settings.apiKey)
    }
  })

  ipcMain.handle('quickaction:status', () => quickActionInstalled())
  ipcMain.handle('quickaction:install', () => installQuickAction())

  ipcMain.handle('app:focus-main', (_e, route?: string) => {
    hidePreview()
    focusMain(route)
  })
}
