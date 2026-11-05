// IPC：应用级：版本与更新、退出握手、桌宠、订阅与支付、数据清除/导出、插件市场。
// 通道清单以 src/shared/ipc-channels.ts 为准；这里只是按领域归位的注册。
import { ipcMain } from './register'
import { app, dialog } from 'electron'
import { writeFileSync } from 'fs'
import { exportRange } from '../db'
import { closePayment, openPayment } from '../payment'
import { broadcast, focusMain, hidePreview } from '../windows'
import {
  disablePlugin,
  enablePlugin,
  initPluginIpc,
  states as pluginStates,
  uninstallPlugin
} from '../plugins/index.ts'
import {
  applyExternalPetSay,
  setPetBubblesEnabled,
  setPetEnabled,
  setPetScaleValue,
  setPetPausedState,
  resetPetPosition
} from '../pet/controller'
import { getPetPrefs } from '../pet/state'
import { hidePetChat, resizePetChat } from '../pet/pet-chat-window'
import { checkForUpdates, getUpdateState, downloadMacUpdate, installMacUpdate, cancelPendingUpdate } from '../updater'
import { registerExitResponse } from '../exit-lifecycle'
import { assertContentEpoch, captureContentEpoch } from '../content-lifecycle'
import { resetAllUserContent } from '../data-reset'

// 到期提醒每次运行只发一次（应用常驻，重启即重置）
let renewReminded = false

export function registerAppIpc(): void {
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
  ipcMain.handle('app:update-state', () => getUpdateState())
  ipcMain.handle('app:download-update', () => downloadMacUpdate())
  ipcMain.handle('app:cancel-update', () => cancelPendingUpdate())
  ipcMain.handle('app:install-update', () => installMacUpdate())
  ipcMain.handle('app:exit-response', (event, response: unknown) => registerExitResponse(event, response))

  ipcMain.handle('data:wipe', async () => {
    await resetAllUserContent()
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

  // 数据导出：时间范围内的工作记录/日报/应用时长/检测 → JSON 文件
  ipcMain.handle('data:export-range', async (_e, fromDay: string, toDay: string) => {
    const epoch = captureContentEpoch()
    const res = await dialog.showSaveDialog({
      title: '导出数据',
      defaultPath: `guzi-assistant-export-${fromDay}_${toDay}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return false
    assertContentEpoch(epoch)
    writeFileSync(res.filePath, JSON.stringify(exportRange(fromDay, toDay), null, 2), 'utf8')
    return true
  })

  // 对话历史：桌宠气泡和主窗悬浮助手是两个渲染进程，共用库里这一份，
  // 任一处改动落库后通知另一处重拉（快捷提问框不参与，它按设计每次都是新对话）。
  ipcMain.handle('pet:chat-resize', (_e, height: number) => resizePetChat(height))

  ipcMain.handle('app:focus-main', (_e, route?: string) => {
    hidePreview()
    focusMain(route)
  })

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
