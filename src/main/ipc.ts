import { dialog, ipcMain, nativeTheme, shell, systemPreferences } from 'electron'
import {
  bulkUpdateStatus,
  deleteSourceContent,
  getProfile,
  getSettings,
  getSource,
  getTask,
  listDetections,
  listTasks,
  saveProfile,
  saveSettings,
  searchSources,
  updateTask,
  wipeAll
} from './db'
import { learnNotMine } from '@shared/belonging-learn'
import {
  cancelPending,
  clearPendings,
  readClipboardPending,
  submitFiles,
  submitPending,
  submitScreenshot,
  takeScreenshot
} from './capture'
import { assistantAdd, assistantChat } from './assistant'
import { exportTaskIcs } from './export'
import type { CandidateContext, ChatHistoryItem, ParsedItem } from '@shared/parsing'
import { setHotkey } from './hotkey'
import { installQuickAction, quickActionInstalled } from './quickaction'
import { ensureFeishu, feishuStatus } from './feishu'
import {
  acceptDetection,
  acceptLocal,
  acceptSuggestion,
  aiParse,
  applyScreenSenseSettings,
  dismissDetection,
  scanOnce
} from './screenwatch'
import { downloadLocalModel, getLocalModelStatus, importLocalModel } from './local-model/extractor'
import { setSession } from './session'
import { closePayment, openPayment } from './payment'
import { clearAllShots, deleteShot, readShotDataUrl } from './shotvault'
import { broadcast, broadcastTheme, focusMain, hidePreview, showPreview } from './windows'
import {
  applyExternalPetReaction,
  setPetEnabled,
  setPetScaleValue,
  setPetPausedState,
  resetPetPosition
} from './pet/controller'
import { getPetPrefs } from './pet/state'
import { hidePetChat } from './pet/pet-chat-window'
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

  ipcMain.handle(
    'auth:set-session',
    (_e, s: { functionsBase: string; token: string | null }) => setSession(s)
  )

  ipcMain.handle('settings:get', () => getSettings())
  // 当前解析后的深浅色（渲染窗口启动时拉取一次）
  ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors)
  // 系统外观变化（设置为「跟随系统」时）：广播给所有渲染窗口切 .dark（桌宠由 pet-window 自己的 nativeTheme 监听重渲染）
  nativeTheme.on('updated', () => broadcastTheme())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    let ok = true
    // 快捷键先注册成功再落库，避免把无效组合持久化导致下次启动无快捷键
    if (patch.hotkey !== undefined) {
      ok = setHotkey(patch.hotkey)
      if (!ok) delete patch.hotkey
    }
    saveSettings(patch)
    // 主题：设 themeSource（驱动桌宠/窗口 shouldUseDarkColors）+ 主动广播给所有渲染窗口切 .dark
    if (patch.theme !== undefined) {
      nativeTheme.themeSource = patch.theme
      broadcastTheme()
    }
    if (patch.feishuAppId !== undefined || patch.feishuAppSecret !== undefined) ensureFeishu()
    // 持续监控开关/间隔改动也要即时重启 watcher，否则要等下次改 enabled 才生效
    if (
      patch.screenSenseEnabled !== undefined ||
      patch.screenSenseLocalModel !== undefined ||
      patch.screenSenseHotkey !== undefined ||
      patch.screenSenseContinuous !== undefined ||
      patch.screenSenseIntervalSec !== undefined
    )
      applyScreenSenseSettings()
    broadcast('eshell:settings-updated')
    return ok
  })

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

  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:update', (_e, id: string, patch: Partial<TaskRecord>) => {
    if (patch.status && !STATUSES.includes(patch.status)) return
    updateTask(id, patch)
    if (patch.status === 'done') applyExternalPetReaction('success')
    // #15：用户把任务改判为「不是我的」→ 从其文本提取高精度信号，沉淀个人归属词典
    if (patch.belongsToUser === 'no') {
      const task = getTask(id)
      const profile = getProfile()
      if (task && profile) {
        const next = learnNotMine(profile, `${task.title} ${task.belongingReason ?? ''}`)
        if (next !== profile) saveProfile(next)
      }
    }
    broadcast('eshell:tasks-updated')
  })
  ipcMain.handle('tasks:bulk', (_e, ids: string[], status: TaskStatus) => {
    if (!STATUSES.includes(status)) return
    bulkUpdateStatus(ids, status)
    broadcast('eshell:tasks-updated')
  })

  ipcMain.handle('source:get', (_e, id: string) => getSource(id))
  ipcMain.handle('memory:search', (_e, query: string) => searchSources(query))
  ipcMain.handle('memory:read-shot', (_e, id: string) => readShotDataUrl(id))

  // 桌宠设置（设置页用）
  ipcMain.handle('pet:get-prefs', () => {
    const p = getPetPrefs()
    return { enabled: p.enabled, scale: p.scale, paused: p.paused }
  })
  ipcMain.handle('pet:set-enabled', (_e, enabled: boolean) => setPetEnabled(enabled))
  ipcMain.handle('pet:set-scale', (_e, scale: number) => setPetScaleValue(scale))
  ipcMain.handle('pet:set-paused', (_e, paused: boolean) => setPetPausedState(paused))
  ipcMain.handle('pet:reset-position', () => resetPetPosition())
  ipcMain.handle('pet:chat-hide', () => hidePetChat())
  ipcMain.handle('source:delete', (_e, id: string) => {
    deleteSourceContent(id)
    deleteShot(id) // 删来源原文时一并删其加密截图
    broadcast('eshell:tasks-updated')
  })

  ipcMain.handle('data:wipe', () => {
    wipeAll()
    clearAllShots() // 一键清除覆盖加密截图（#53）
    broadcast('eshell:tasks-updated')
  })

  ipcMain.handle('permissions:get', (): PermissionStatus => {
    const settings = getSettings()
    return {
      screen:
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
      apiConfigured: !!(settings.apiBase && settings.apiKey)
    }
  })

  // 首启屏幕录制授权引导：打开系统设置的「屏幕录制」面板（仅 macOS）
  ipcMain.handle('permissions:open-screen-settings', () => {
    if (process.platform === 'darwin')
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      )
  })

  ipcMain.handle('quickaction:status', () => quickActionInstalled())
  ipcMain.handle('quickaction:install', () => installQuickAction())
  ipcMain.handle('feishu:status', () => feishuStatus())
  ipcMain.handle('screen:scan', () => scanOnce())
  ipcMain.handle('suggestion:accept', (_e, payload: { item: ParsedItem; sourceText: string }) =>
    acceptSuggestion(payload)
  )
  ipcMain.handle('suggestion:ai-parse', (_e, sourceText: string) => aiParse(sourceText))
  ipcMain.handle(
    'suggestion:accept-local',
    (_e, p: { item: ParsedItem; sourceText: string; detectionId?: string }) => acceptLocal(p)
  )
  ipcMain.handle('detections:list', () => listDetections())
  ipcMain.handle('detections:accept', (_e, id: string) => acceptDetection(id))
  ipcMain.handle('detections:dismiss', (_e, id: string) => dismissDetection(id))

  ipcMain.handle('localmodel:status', () => getLocalModelStatus())
  ipcMain.handle('localmodel:download', async () => {
    const { localModelEndpoint } = getSettings()
    await downloadLocalModel(
      (p) => broadcast('eshell:localmodel-progress', { progress: p }),
      localModelEndpoint || undefined
    )
    applyScreenSenseSettings()
    return getLocalModelStatus()
  })
  ipcMain.handle('localmodel:import', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择本地模型文件（.gguf）',
      filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return getLocalModelStatus()
    await importLocalModel(r.filePaths[0])
    applyScreenSenseSettings()
    return getLocalModelStatus()
  })

  ipcMain.handle(
    'assistant:chat',
    (_e, payload: { history: ChatHistoryItem[]; candidates: CandidateContext | null }) =>
      assistantChat(payload)
  )
  ipcMain.handle(
    'assistant:add',
    (_e, payload: { sourceText: string; item: ParsedItem; force?: boolean }) => assistantAdd(payload)
  )

  ipcMain.handle('app:focus-main', (_e, route?: string) => {
    hidePreview()
    focusMain(route)
  })

  ipcMain.handle('task:export-ics', (_e, task: TaskRecord) => exportTaskIcs(task))

  ipcMain.handle('payment:open', (_e, payUrl: string, params: Record<string, string>) =>
    openPayment(payUrl, params)
  )
  ipcMain.handle('payment:close', () => closePayment())
}
