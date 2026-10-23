import { app, BrowserWindow, dialog } from 'electron'
import { beginContentReset } from './content-lifecycle'
import { clearUserContentFiles } from './content-files'
import { wipeAll } from './db/maintenance'
import { acquireHistoryMutationBarrier, clearHistory, stopHistoryPersistence } from './history/service'
import { applyScreenSenseSettings, stopWatch } from './screenwatch'
import { applyClipWatchSettings, stopClipWatch } from './clipwatch'
import { applyVoiceSettings, resetVoiceContent } from './voicenotes/service'
import { resumePluginRuntime, suspendPluginRuntime } from './plugins/index'
import { applyTaskReminderSchedule, stopTaskReminder } from './task-reminder'
import { stopReportSchedule } from './report-scheduler'
import { initDropbox, stopDropbox } from './dropbox'
import { applyMcpSettings, stopMcpServer } from './mcp-server'
import { unregisterScanHotkey } from './hotkey'
import { clearPendings } from './capture'
import { hidePreview } from './windows'
import { hideReminderWindow } from './reminder-window'
import { hideQuickBar } from './quickbar'
import { hidePetChat } from './pet/pet-chat-window'
import { resetPetContent } from './pet/controller'

export async function resetAllUserContent(): Promise<void> {
  const releaseContentBarrier = beginContentReset()
  const releaseHistoryBarrier = acquireHistoryMutationBarrier()
  let clearFailure: { error: unknown } | null = null
  const recoveryErrors: string[] = []
  const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const recover = (name: string, action: () => void): void => {
    try {
      action()
    } catch (error) {
      recoveryErrors.push(`${name}：${describe(error)}`)
    }
  }
  try {
    stopWatch()
    unregisterScanHotkey()
    stopClipWatch()
    stopTaskReminder()
    stopReportSchedule()
    stopDropbox()
    stopMcpServer()
    suspendPluginRuntime()
    clearPendings()
    hidePreview()
    hideReminderWindow()
    hideQuickBar()
    hidePetChat()
    resetPetContent()
    await Promise.all([resetVoiceContent(), stopHistoryPersistence()])
    await clearHistory()
    await stopHistoryPersistence()
    wipeAll()
    await clearUserContentFiles(app.getPath('userData'))
  } catch (error) {
    clearFailure = { error }
  } finally {
    releaseHistoryBarrier()
    releaseContentBarrier()
    // 旧页面的内容版本已经永久失效，连清理失败也要重载才能继续操作。
    recover('读取窗口列表失败', () => {
      for (const win of BrowserWindow.getAllWindows()) {
        recover('重载窗口失败', () => {
          if (!win.isDestroyed()) win.webContents.reload()
        })
      }
    })
    const services: [string, () => void][] = [
      ['恢复插件运行失败', resumePluginRuntime],
      ['恢复屏幕采集失败', applyScreenSenseSettings],
      ['恢复剪切板监听失败', applyClipWatchSettings],
      ['恢复语音监听失败', applyVoiceSettings],
      ['恢复任务提醒失败', applyTaskReminderSchedule],
      ['恢复投递监听失败', initDropbox],
      ['恢复 MCP 服务失败', applyMcpSettings]
    ]
    for (const [name, resume] of services) recover(name, resume)
  }
  if (clearFailure || recoveryErrors.length) {
    const details = [
      ...(clearFailure ? [`未能清除全部用户内容：${describe(clearFailure.error)}`] : []),
      ...recoveryErrors
    ].join('\n')
    dialog.showErrorBox('清除未完成', details)
    if (clearFailure) throw clearFailure.error
    throw new Error(details)
  }
}
