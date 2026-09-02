import { app, dialog, ipcMain, nativeTheme, shell, systemPreferences } from 'electron'
import { writeFileSync } from 'fs'
import {
  addFocusTask,
  appUsageSummary,
  bulkUpdateStatus,
  clearChatMessages,
  listChatMessages,
  saveChatMessages,
  deleteReport,
  deleteSourceContent,
  deleteTask,
  deleteWorkRecord,
  appUsageRange,
  exportRange,
  getPersonalMemory,
  listAppCategoryOverrides,
  listAppSwitchesSince,
  setAppCategoryOverride,
  hideFocusTask,
  listFocusTaskPrefs,
  getProfile,
  getSettings,
  addDetectionNote,
  cleanupStaleDetections,
  getSource,
  getTask,
  listPendingDetections,
  listVoiceSessions,
  listReports,
  listTasks,
  listWorkRecords,
  listWorkRecordsSince,
  saveProfile,
  saveSettings,
  setPersonalMemory,
  setTaskSnooze,
  updateTask,
  wipeAll,
  wipeMemory
} from './db'
import { generateDailyReport } from './report'
import { refreshBaseMemory, refreshPersonalMemory } from './personal-memory'
import { learnNotMine } from '@shared/belonging-learn'
import {
  cancelPending,
  clearPendings,
  HINTS,
  readClipboardPending,
  submitFiles,
  submitPending,
  submitScreenshot,
  takeScreenshot
} from './capture'
import { parseToItems, probeModelEndpoint } from './parser'
import { assistantAdd, assistantChat, notifyQuickChatResult } from './assistant'
import { exportTaskIcs } from './export'
import type { CandidateContext, ChatHistoryItem, ParsedItem } from '@shared/parsing'
import { setHotkey, setNamedHotkey, setScreenshotHotkey } from './hotkey'
import { installQuickAction, quickActionInstalled } from './quickaction'
import { ensureFeishu, feishuStatus } from './feishu'
import { applyScreenSenseSettings, scanOnce, screenActivityStatus } from './screenwatch'
import {
  acceptDetection,
  acceptLocal,
  acceptLocalBatch,
  acceptSuggestion,
  dismissDetection
} from './detection-cards'
import {
  acquireHistoryMutationBarrier,
  clearHistory,
  deleteHistoryRange,
  historyRecent,
  historySearch,
  historyStatus,
  historySummarize,
  pauseHistory,
  resumeHistory
} from './history/service.ts'
import { pickHistoryApps } from './history/app-picker.ts'
import { setSession } from './session'
import { closePayment, openPayment } from './payment'
import { clearAllShots, deleteShot, readShotDataUrl } from './shotvault'
import {
  broadcast,
  broadcastExcept,
  broadcastTheme,
  focusMain,
  hidePreview,
  resizePreview,
  showPreview
} from './windows'
import {
  disablePlugin,
  enablePlugin,
  initPluginIpc,
  states as pluginStates,
  uninstallPlugin
} from './plugins/index.ts'
import {
  applyExternalPetReaction,
  applyExternalPetSay,
  clearPetPersistentSay,
  setPetBubblesEnabled,
  setPetEnabled,
  setPetScaleValue,
  setPetPausedState,
  resetPetPosition
} from './pet/controller'
import { getPetPrefs } from './pet/state'
import { hideReminderWindow, resizeReminder } from './reminder-window'
import { applyTaskReminderSchedule } from './task-reminder'
import { applyClipWatchSettings } from './clipwatch'
import { localIso } from '@shared/task-reminder'
import { hidePetChat, resizePetChat } from './pet/pet-chat-window'
import { hideQuickBar, isQuickBarVisible, resizeQuickBar } from './quickbar'
import { applyMcpSettings } from './mcp-server'
import { probeTranscription } from './voicenotes/transcribe'
import {
  applyVoiceSettings,
  currentVoiceSession,
  ingestSegment,
  startVoiceSession,
  stopVoiceSession
} from './voicenotes/service'
import { checkForUpdates } from './updater'
import type {
  AppSettings,
  LaunchAtLoginState,
  PermissionStatus,
  Profile,
  TaskRecord,
  TaskStatus
} from '@shared/types'
import type { HistoryQueryOptions, HistorySearchOptions } from '@shared/history'
import type { PcmSegment } from '@shared/voicenotes'

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

/** 提交屏幕截图：交互框选截图 → 送解析。供全局快捷键调用。 */
export function triggerScreenshotCapture(): void {
  void (async () => {
    const dataUrl = await takeScreenshot()
    if (dataUrl) await submitScreenshot(dataUrl)
  })()
}

// 到期提醒每次运行只发一次（应用常驻，重启即重置）
let renewReminded = false

// 开机自启的真值只存在系统登录项里（macOS 13+ 走 SMAppService），settings 表不留副本——
// 用户随时可能在「系统设置 → 通用 → 登录项」里手动增删，那边不会回调应用，留副本必然对不上。
function readLaunchAtLogin(): LaunchAtLoginState {
  const s = app.getLoginItemSettings()
  return {
    supported: app.isPackaged,
    enabled: s.openAtLogin,
    requiresApproval: s.status === 'requires-approval'
  }
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
  // 设置页「检测连接」：用表单里的现值探测，不必先保存
  ipcMain.handle('model:probe', (_e, apiBase: string, apiKey: string) =>
    probeModelEndpoint(String(apiBase ?? ''), String(apiKey ?? ''))
  )
  // ---------- 语音纪要 ----------
  ipcMain.handle('voice:probe', () => probeTranscription())
  ipcMain.handle('voice:start', () => startVoiceSession(null))
  ipcMain.handle('voice:stop', () => stopVoiceSession())
  ipcMain.handle('voice:state', () => currentVoiceSession())
  ipcMain.handle('voice:sessions', () => listVoiceSessions())
  // 分段是渲染层按停顿切好后送来的；转录耗时长，这里不 await，避免堵住录音那一侧
  ipcMain.handle('voice:segment', (_e, segment: PcmSegment) => {
    void ingestSegment(segment)
  })
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    let ok = true
    if (
      patch.screenSenseEventDriven !== undefined &&
      typeof patch.screenSenseEventDriven !== 'boolean'
    )
      delete patch.screenSenseEventDriven
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
      patch.screenSenseHotkey !== undefined ||
      patch.screenSenseContinuous !== undefined ||
      patch.screenSenseIntervalSec !== undefined ||
      patch.screenSenseEventDriven !== undefined ||
      patch.historyV2Enabled !== undefined ||
      patch.historyDerivedWorkEnabled !== undefined ||
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

  // ---------- 任务提醒卡 ----------
  // 提醒的幂等键（reminded_at）在触发时就已写入，所以「知道了」不需要再写任何东西。
  const closeReminder = (): void => {
    hideReminderWindow()
    clearPetPersistentSay()
  }
  ipcMain.handle('reminder:done', (_e, taskId: string) => {
    updateTask(taskId, { status: 'done' })
    applyExternalPetReaction('success')
    broadcast('guzi-assistant:tasks-updated')
  })
  ipcMain.handle('reminder:snooze', (_e, taskId: string, minutes: number) => {
    const safe = Math.min(24 * 60, Math.max(1, Math.round(minutes)))
    setTaskSnooze(taskId, localIso(Date.now() + safe * 60_000))
  })
  ipcMain.handle('reminder:close', () => closeReminder())
  ipcMain.handle('reminder:resize', (_e, height: number) => resizeReminder(Number(height) || 0))
  ipcMain.handle('reminder:open-schedule', () => {
    closeReminder()
    focusMain('schedule')
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
    broadcast('guzi-assistant:tasks-updated')
  })
  ipcMain.handle('tasks:bulk', (_e, ids: string[], status: TaskStatus) => {
    if (!STATUSES.includes(status)) return
    bulkUpdateStatus(ids, status)
    broadcast('guzi-assistant:tasks-updated')
  })
  ipcMain.handle('tasks:delete', (_e, id: string) => {
    deleteTask(String(id))
    broadcast('guzi-assistant:tasks-updated')
  })

  ipcMain.handle('source:get', (_e, id: string) => getSource(id))
  ipcMain.handle('memory:read-shot', (_e, id: string) => readShotDataUrl(id))

  // 桌宠设置（设置页用）
  ipcMain.handle('pet:get-prefs', () => {
    const p = getPetPrefs()
    return { enabled: p.enabled, scale: p.scale, paused: p.paused, bubbles: p.bubbles }
  })
  ipcMain.handle('pet:set-enabled', (_e, enabled: boolean) => setPetEnabled(enabled))
  ipcMain.handle('pet:set-bubbles', (_e, on: boolean) => setPetBubblesEnabled(on))
  ipcMain.handle('pet:set-scale', (_e, scale: number) => setPetScaleValue(scale))
  ipcMain.handle('pet:set-paused', (_e, paused: boolean) => setPetPausedState(paused))
  ipcMain.handle('pet:reset-position', () => resetPetPosition())
  ipcMain.handle('pet:chat-hide', () => hidePetChat())
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:check-update', () => checkForUpdates(true))
  ipcMain.handle('app:launch-at-login', () => readLaunchAtLogin())
  ipcMain.handle('app:set-launch-at-login', (_e, enabled: boolean) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled })
    return readLaunchAtLogin()
  })
  ipcMain.handle('quickbar:hide', () => hideQuickBar())
  ipcMain.handle('quickbar:resize', (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) resizeQuickBar(height)
  })
  ipcMain.handle('source:delete', (_e, id: string) => {
    deleteSourceContent(id)
    deleteShot(id) // 删来源原文时一并删其加密截图
    broadcast('guzi-assistant:tasks-updated')
  })

  ipcMain.handle('data:wipe', async () => {
    const releaseHistoryBarrier = acquireHistoryMutationBarrier()
    try {
      await clearHistory()
      wipeAll()
      clearAllShots() // 一键清除覆盖加密截图（#53）
      broadcast('guzi-assistant:tasks-updated')
    } finally {
      releaseHistoryBarrier()
    }
  })

  // 记忆页「清空所有记忆」：清来源历史 + 屏幕识别历史 + 加密截图；保留任务/校正记忆/档案
  ipcMain.handle('memory:wipe', async () => {
    const releaseHistoryBarrier = acquireHistoryMutationBarrier()
    try {
      await clearHistory()
      wipeMemory()
      clearAllShots()
      broadcast('guzi-assistant:tasks-updated')
    } finally {
      releaseHistoryBarrier()
    }
  })

  ipcMain.handle('permissions:get', (): PermissionStatus => {
    const settings = getSettings()
    return {
      screen:
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
      microphone:
        process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus('microphone')
          : 'granted',
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
  ipcMain.handle('screen:activity-status', () => screenActivityStatus())
  ipcMain.handle('history:status', () => historyStatus())
  ipcMain.handle('history:recent', (_e, options: HistoryQueryOptions = {}) => historyRecent(options))
  ipcMain.handle('history:search', (_e, options: HistorySearchOptions = {}) => historySearch(options))
  ipcMain.handle('history:summarize', (_e, options: HistoryQueryOptions = {}) => historySummarize(options))
  ipcMain.handle('history:pause', () => pauseHistory())
  ipcMain.handle('history:resume', () => resumeHistory())
  ipcMain.handle('history:clear', () => clearHistory())
  ipcMain.handle('history:delete-range', (_e, options: HistoryQueryOptions) => deleteHistoryRange(options ?? {}))
  ipcMain.handle('history:pick-apps', () => pickHistoryApps())
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
  // 检测卡「备注」：存反馈（注入后续提示词）+「不是我的」语义顺带走归属学习 + 关闭该检测
  // 日程页悬浮加号·自然语言快建：解析后强制归属本人直接入库（用户亲手输入，无需再走确认流）
  ipcMain.handle('tasks:quick-add', async (_e, text: string) => {
    const hint = `${HINTS.text_input}\n这是用户在日程页为自己手动创建的日程/待办（belongs_to_user 一律填 yes），请尽量解析出明确时间。`
    const items = await parseToItems({ text, hint })
    for (const item of items)
      assistantAdd({
        sourceText: `手动创建：${text.slice(0, 200)}`,
        item: { ...item, belongs_to_user: 'yes' },
        force: true
      })
    broadcast('guzi-assistant:tasks-updated')
    return { added: items.length, titles: items.map((i) => i.title) }
  })

  // 订阅/试用到期前提醒：渲染层查到快到期时让桌宠说一次（每次运行只提醒一回，不烦人）
  ipcMain.handle('subscription:remind', (_e, kind: 'trial' | 'paid', days: number) => {
    if (renewReminded) return
    renewReminded = true
    applyExternalPetSay(
      kind === 'trial' ? `试用还剩 ${days} 天，订阅后不间断陪你～` : `订阅还有 ${days} 天到期，记得续费～`,
      'waiting',
      { durationMs: 12_000 }
    )
  })
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
  // 工作记录 / 应用时长 / 日报（「日报」页）
  ipcMain.handle('work-records:list', (_e, day: string) => listWorkRecords(day))
  ipcMain.handle('work-records:since', (_e, sinceDay: string) => listWorkRecordsSince(sinceDay))
  ipcMain.handle('work-records:delete', (_e, id: string) => deleteWorkRecord(id))

  // 注意力分析（「分析」页）：切换事件 + 时长范围 + 应用分类覆盖
  ipcMain.handle('app-usage:range', (_e, fromDay: string, toDay: string) =>
    appUsageRange(fromDay, toDay)
  )
  ipcMain.handle('app-switches:since', (_e, sinceDay: string) => listAppSwitchesSince(sinceDay))
  ipcMain.handle('app-categories:list', () => listAppCategoryOverrides())
  ipcMain.handle('app-categories:set', (_e, app: string, category: string | null) =>
    setAppCategoryOverride(app, category)
  )

  // 个人记忆（「记忆」页：base=基本画像 / recent=近期行为画像）
  ipcMain.handle('memory:get-personal', () => getPersonalMemory())
  ipcMain.handle('memory:set-personal', (_e, part: 'base' | 'recent', content: string) =>
    setPersonalMemory(part === 'base' ? 'base' : 'recent', content)
  )
  ipcMain.handle('memory:refresh-personal', (_e, part?: 'base' | 'recent') =>
    part === 'base' ? refreshBaseMemory() : refreshPersonalMemory()
  )

  // 任务专注（日报页）：自定义添加 / 删除（隐藏）任务名，用于校正模型归并
  ipcMain.handle('focus-tasks:prefs', () => listFocusTaskPrefs())
  ipcMain.handle('focus-tasks:add', (_e, name: string) => addFocusTask(name))
  ipcMain.handle('focus-tasks:hide', (_e, name: string) => hideFocusTask(name))

  // 数据导出：时间范围内的工作记录/日报/应用时长/检测 → JSON 文件
  ipcMain.handle('data:export-range', async (_e, fromDay: string, toDay: string) => {
    const res = await dialog.showSaveDialog({
      title: '导出数据',
      defaultPath: `guzi-assistant-export-${fromDay}_${toDay}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return false
    writeFileSync(res.filePath, JSON.stringify(exportRange(fromDay, toDay), null, 2), 'utf8')
    return true
  })
  ipcMain.handle('app-usage:summary', (_e, day: string) => appUsageSummary(day))
  ipcMain.handle('reports:generate', async (_e, day: string) => {
    const r = await generateDailyReport(day)
    broadcast('guzi-assistant:reports-updated')
    return r
  })
  ipcMain.handle('reports:list', () => listReports())
  ipcMain.handle('reports:delete', (_e, id: string) => deleteReport(id))
  ipcMain.handle('report:export', async (_e, r: { title: string; content: string }) => {
    const res = await dialog.showSaveDialog({
      title: '导出日报',
      defaultPath: `${r.title}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return false
    writeFileSync(res.filePath, r.content, 'utf8')
    return true
  })

  ipcMain.handle(
    'assistant:chat',
    (_e, payload: { history: ChatHistoryItem[]; candidates: CandidateContext | null }) =>
      assistantChat(payload)
  )
  // 快捷提问框：发送后即可关闭输入框——处理在主进程完成；结束时输入框已收起则改由桌宠气泡播报，
  // 未确认候选转入检测卡/日程页待确认区，不随输入框关闭丢失
  ipcMain.handle(
    'assistant:quick-chat',
    async (_e, payload: { history: ChatHistoryItem[]; candidates: CandidateContext | null }) => {
      const res = await assistantChat(payload)
      if (!isQuickBarVisible()) {
        const lastUserText = [...payload.history].reverse().find((m) => m.role === 'user')?.content ?? ''
        notifyQuickChatResult(res, lastUserText, payload.candidates != null)
      }
      return res
    }
  )
  ipcMain.handle(
    'assistant:add',
    (_e, payload: { sourceText: string; item: ParsedItem; force?: boolean }) => assistantAdd(payload)
  )

  // 对话历史：桌宠气泡和主窗悬浮助手是两个渲染进程，共用库里这一份，
  // 任一处改动落库后通知另一处重拉（快捷提问框不参与，它按设计每次都是新对话）。
  ipcMain.handle('pet:chat-resize', (_e, height: number) => resizePetChat(height))
  ipcMain.handle('chat:history', (_e, scope: string) => listChatMessages(scope))
  ipcMain.handle('chat:save', (e, scope: string, msgs: unknown[]) => {
    saveChatMessages(scope, msgs)
    broadcastExcept(e.sender.id, 'guzi-assistant:chat-updated', { scope })
  })
  ipcMain.handle('chat:clear', (e, scope: string) => {
    clearChatMessages(scope)
    broadcastExcept(e.sender.id, 'guzi-assistant:chat-updated', { scope })
  })

  ipcMain.handle('app:focus-main', (_e, route?: string) => {
    hidePreview()
    focusMain(route)
  })

  ipcMain.handle('task:export-ics', (_e, task: TaskRecord) => exportTaskIcs(task))

  ipcMain.handle('payment:open', (_e, payUrl: string, params: Record<string, string>) =>
    openPayment(payUrl, params)
  )
  ipcMain.handle('payment:close', () => closePayment())

  // ---------- 插件市场 ----------
  // 插件自己的通道（plugin:<id>:*）不在这里注册——它们随启用/停用动态挂载和摘除，
  // 见 plugins/index.ts。这里只有市场本身的四个操作。
  ipcMain.handle('plugins:list', () => pluginStates())

  ipcMain.handle('plugins:enable', (_e, id: string) => {
    const result = enablePlugin(id)
    if (result.added.length) broadcast('guzi-assistant:plugins-updated')
    return { ...result, states: pluginStates() }
  })

  ipcMain.handle('plugins:disable', (_e, id: string) => {
    const result = disablePlugin(id)
    if (result.removed.length) broadcast('guzi-assistant:plugins-updated')
    return { ...result, states: pluginStates() }
  })

  // 卸载会 DROP 掉插件的表，不可逆。渲染层负责二次确认，这里不再拦。
  ipcMain.handle('plugins:uninstall', (_e, id: string) => {
    const result = uninstallPlugin(id)
    broadcast('guzi-assistant:plugins-updated')
    return { ...result, states: pluginStates() }
  })

  initPluginIpc()
}
