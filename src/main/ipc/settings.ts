// IPC：档案、设置、主题、模型/权限探测、访达快速操作、飞书与开机自启。
// 通道清单以 src/shared/ipc-channels.ts 为准；这里只是按领域归位的注册。
import { ipcMain } from './register'
import { app, nativeTheme, shell, systemPreferences } from 'electron'
import { getProfile, getSettings, saveProfile, saveSettings } from '../db'
import { probeModelEndpoint } from '../parser'
import { setHotkey, setNamedHotkey, setScreenshotHotkey } from '../hotkey'
import { installQuickAction, quickActionInstalled, uninstallQuickAction } from '../quickaction'
import { ensureFeishu, feishuStatus } from '../feishu'
import { applyScreenSenseSettings, resetScreenRecognitionRetry } from '../screenwatch'
import { invalidateHistoryContent } from '../history/service.ts'
import { setSession } from '../session'
import { broadcast, broadcastTheme } from '../windows'
import { applyTaskReminderSchedule } from '../task-reminder'
import { applyClipWatchSettings } from '../clipwatch'
import { applyMcpSettings } from '../mcp-server'
import { applyVoiceSettings } from '../voicenotes/service'
import type { AppSettings, LaunchAtLoginState, PermissionStatus, Profile } from '@shared/types'

// 开机自启的真值只存在系统登录项里（macOS 13+ 走 SMAppService），settings 表不留副本——
// 用户随时可能在「系统设置 → 通用 → 登录项」里手动增删，那边不会回调应用，留副本必然对不上。
function readLaunchAtLogin(): LaunchAtLoginState {
  const s = app.getLoginItemSettings(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : undefined)
  return {
    supported: app.isPackaged,
    enabled: s.openAtLogin,
    requiresApproval: s.status === 'requires-approval'
  }
}

export function registerSettingsIpc(): void {
  ipcMain.handle('profile:get', () => getProfile())
  ipcMain.handle('profile:save', (_e, p: Profile) => saveProfile(p))

  ipcMain.handle(
    'auth:set-session',
    (_e, s: { functionsBase: string; token: string | null }) => setSession(s)
  )

  ipcMain.handle('settings:get', () => getSettings())
  // 当前解析后的深浅色（渲染窗口启动时拉取一次）
  ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors)
  // 系统外观变化（设置为「跟随系统」时）：广播给所有渲染窗口切 .dark（桌宠由 pet-window 自己的 nativeTheme 监听重渲染）
  nativeTheme.on('updated', () => broadcastTheme())
  // 设置页「检测连接」：用表单里的现值探测，不必先保存
  ipcMain.handle('model:probe', (_e, apiBase: string, apiKey: string, apiFormat?: string, model?: string) =>
    probeModelEndpoint(String(apiBase ?? ''), String(apiKey ?? ''), apiFormat, model)
  )
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    let ok = true
    if (patch.screenSenseFallbackIntervalSec !== undefined) {
      const value = Number(patch.screenSenseFallbackIntervalSec)
      patch.screenSenseFallbackIntervalSec = Number.isFinite(value)
        ? Math.min(60, Math.max(30, Math.round(value)))
        : 45
    }
    if (patch.screenSenseIntervalSec !== undefined) {
      const value = Number(patch.screenSenseIntervalSec)
      patch.screenSenseIntervalSec = Number.isFinite(value)
        ? Math.min(60, Math.max(1, Math.round(value)))
        : 5
    }
    if (patch.taskReminderOffsetMin !== undefined) {
      const value = Number(patch.taskReminderOffsetMin)
      patch.taskReminderOffsetMin = Number.isFinite(value)
        ? Math.min(1440, Math.max(0, Math.round(value)))
        : 5
    }
    if (patch.todoScanIntervalSec !== undefined) {
      const value = Number(patch.todoScanIntervalSec)
      patch.todoScanIntervalSec = Number.isFinite(value)
        ? Math.min(600, Math.max(60, Math.round(value)))
        : 180
    }
    // 快捷键先注册成功再落库，避免把无效组合持久化导致下次启动无快捷键
    if (patch.hotkey !== undefined) {
      ok = setHotkey(patch.hotkey)
      if (!ok) delete patch.hotkey
    }
    if (patch.screenshotHotkey !== undefined) {
      ok = setScreenshotHotkey(patch.screenshotHotkey)
      if (!ok) delete patch.screenshotHotkey
    }
    if (patch.mainWindowHotkey !== undefined) {
      ok = setNamedHotkey('mainWindow', patch.mainWindowHotkey)
      if (!ok) delete patch.mainWindowHotkey
    }
    if (patch.petVoiceHotkey !== undefined) {
      ok = setNamedHotkey('petVoice', patch.petVoiceHotkey)
      if (!ok) delete patch.petVoiceHotkey
    }
    if (patch.quickAskHotkey !== undefined) {
      ok = setNamedHotkey('quickAsk', patch.quickAskHotkey)
      if (!ok) delete patch.quickAskHotkey
    }
    const activityPolicyChanged = ['historyV2Enabled', 'historyExcludedApps', 'historyExcludedHosts', 'historyIncludedHosts',
      'screenSenseExcludedApps'].some((key) => key in patch)
    if (activityPolicyChanged) invalidateHistoryContent()
    saveSettings(patch)
    if (['apiBase', 'apiKey', 'apiFormat', 'model', 'modelVision', 'useCustomModel'].some((key) => key in patch))
      resetScreenRecognitionRetry()
    // 主题：设 themeSource（驱动桌宠/窗口 shouldUseDarkColors）+ 主动广播给所有渲染窗口切 .dark
    if (patch.theme !== undefined) {
      nativeTheme.themeSource = patch.theme
      broadcastTheme()
    }
    if (patch.feishuAppId !== undefined || patch.feishuAppSecret !== undefined) ensureFeishu()
    // 持续监控开关/间隔改动也要即时重启 watcher，否则要等下次改 enabled 才生效
    if (
      patch.screenSenseEnabled !== undefined ||
      patch.screenSenseHotkey !== undefined ||
      patch.screenSenseContinuous !== undefined ||
      patch.screenSenseIntervalSec !== undefined ||
      activityPolicyChanged ||
      patch.dailyReportTime !== undefined
    )
      applyScreenSenseSettings()
    if (patch.taskReminderEnabled !== undefined) applyTaskReminderSchedule()
    if (patch.clipWatchEnabled !== undefined) applyClipWatchSettings()
    if (patch.mcpEnabled !== undefined || patch.mcpPort !== undefined || patch.mcpToken !== undefined)
      applyMcpSettings()
    if (patch.voiceNotesEnabled !== undefined || patch.voiceAutoStart !== undefined)
      applyVoiceSettings()
    broadcast('guzi-assistant:settings-updated')
    return ok
  })
  ipcMain.handle('app:launch-at-login', () => readLaunchAtLogin())
  ipcMain.handle('app:set-launch-at-login', (_e, enabled: boolean) => {
    if (app.isPackaged) app.setLoginItemSettings({
      openAtLogin: enabled,
      ...(process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {})
    })
    return readLaunchAtLogin()
  })

  ipcMain.handle('permissions:get', (): PermissionStatus => {
    const settings = getSettings()
    return {
      screen:
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown',
      microphone:
        process.platform === 'darwin' || process.platform === 'win32'
          ? systemPreferences.getMediaAccessStatus('microphone')
          : 'unknown',
      apiConfigured: !!(settings.apiBase && settings.apiKey)
    }
  })

  // 首启屏幕录制授权引导：打开系统设置的「屏幕录制」面板（仅 macOS）
  ipcMain.handle('permissions:open-screen-settings', () => {
    if (process.platform === 'darwin')
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      )
    if (process.platform === 'win32') void shell.openExternal('ms-settings:privacy-screencapture')
  })

  ipcMain.handle('quickaction:status', () => quickActionInstalled())
  ipcMain.handle('quickaction:install', () => installQuickAction())
  ipcMain.handle('quickaction:uninstall', () => uninstallQuickAction())
  ipcMain.handle('feishu:status', () => feishuStatus())
}
