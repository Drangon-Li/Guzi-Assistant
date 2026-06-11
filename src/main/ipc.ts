import { ipcMain, shell, systemPreferences } from 'electron'
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
  readClipboardPending,
  submitFiles,
  submitPending,
  submitScreenshot,
  submitText,
  takeScreenshot
} from './capture'
import { accessibilityGranted, ensureHotkey, setHotkeyMode } from './hotkey'
import { broadcast, focusMain, hidePreview, showPreview } from './windows'
import type { AppSettings, PermissionStatus, Profile, TaskRecord, TaskStatus } from '@shared/types'

/** Space+C / 托盘共用的剪切板捕获入口 */
export function triggerClipboardCapture(): void {
  showPreview(readClipboardPending())
}

export function registerIpc(): void {
  ipcMain.handle('profile:get', () => getProfile())
  ipcMain.handle('profile:save', (_e, p: Profile) => saveProfile(p))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    saveSettings(patch)
    if (patch.hotkeyMode) setHotkeyMode(patch.hotkeyMode)
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
  ipcMain.handle('preview:hide', () => hidePreview())

  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:update', (_e, id: string, patch: Partial<TaskRecord>) => {
    updateTask(id, patch)
    broadcast('al1:tasks-updated')
  })
  ipcMain.handle('tasks:bulk', (_e, ids: string[], status: TaskStatus) => {
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
    ensureHotkey()
    const settings = getSettings()
    return {
      accessibility: accessibilityGranted(),
      screen:
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
      apiConfigured: !!(settings.apiBase && settings.apiKey)
    }
  })
  ipcMain.handle('permissions:open-accessibility', () =>
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )
  )

  ipcMain.handle('app:focus-main', (_e, route?: string) => {
    hidePreview()
    focusMain(route)
  })
}
