import { floatingPanelOptions } from './platform/window-options'
// 任务提醒卡窗：独立置顶窗，不自动消失，用户必须处理才收。
//
// 为什么不复用 windows.ts 的 preview 窗（两个理由都是硬约束）：
// ① isPreviewVisible() 被持续监控当门控用——卡开着就暂停屏幕感知；提醒卡挂几小时会把感知停死。
// ② 检测卡带 screenSenseCardHideSec 倒计时自动忽略；提醒卡绝不能自动消失。
import { BrowserWindow, screen } from 'electron'
import type { ReminderPayload } from '@shared/types'
import { load, preload } from './windows'
import { whenWindowReady } from './window-ready'

const WIDTH = 360
/** 初始高度；渲染层测出真实内容高度后由 resizeReminder 顶边固定地调整 */
const HEIGHT = 168
const MIN_H = 96
const MAX_H = 520
const MARGIN = 16

// 提醒窗到点才建、处理完就关：一天也就几次提醒，没必要常驻一个渲染进程。
// 提醒的幂等键在触发时就写了，丢了不会再来——首条消息靠就绪握手（window-ready.ts）保证送达，
// 不再靠启动时预建窗口去躲「订阅还没挂上」的竞态。
let reminderWin: BrowserWindow | null = null

function getReminderWindow(): BrowserWindow {
  if (reminderWin && !reminderWin.isDestroyed()) return reminderWin
  reminderWin = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    // 原生 vibrancy 磨砂 + 原生圆角与窗口阴影。这三样 transparent 窗都拿不到——
    // 旧实现是 transparent 窗里画 CSS shadow-2xl，外层只留 8px 内边距，
    // 阴影被窗口边缘裁掉，看着就是一道硬边（用户反馈「阴影效果不好」）。
    // visualEffectState 必须钉成 active：提醒窗用 showInactive() 弹出、从不获焦，
    // 否则磨砂会一直渲染成失活的灰调。做法与 quickbar.ts 一致。
    ...floatingPanelOptions(),
    // 同 preview 窗：不获焦窗口默认会被降到极低帧率，动画会跳帧。
    webPreferences: { preload, backgroundThrottling: false }
  })
  reminderWin.setAlwaysOnTop(true, 'screen-saver')
  reminderWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const win = reminderWin
  win.once('closed', () => {
    if (reminderWin === win) reminderWin = null
  })
  load(win, '/reminder')
  return win
}

/** 放光标所在显示器的右上角——用主显示器会让提醒弹到用户背后那块屏上。 */
function positionReminder(win: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setPosition(
    Math.round(workArea.x + workArea.width - WIDTH - MARGIN),
    Math.round(workArea.y + MARGIN)
  )
}

/** 推一批提醒并弹窗（不抢焦点）。窗已开着时渲染层会把新条目追加进队列。 */
export function showReminders(payload: ReminderPayload): void {
  const win = getReminderWindow()
  if (!win.isVisible()) positionReminder(win)
  whenWindowReady(win, () => {
    win.webContents.send('guzi-assistant:reminder', payload)
    win.showInactive()
  })
}

/** 渲染层量出内容高度后调用：顶边固定向下生长（窗口贴在屏幕右上角）。 */
export function resizeReminder(height: number): void {
  if (!reminderWin || reminderWin.isDestroyed()) return
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(height)))
  const bounds = reminderWin.getBounds()
  if (h === bounds.height) return
  reminderWin.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: h })
}

/** 用户处理完所有提醒：直接关窗释放渲染进程，下一次到点再建 */
export function hideReminderWindow(): void {
  if (reminderWin && !reminderWin.isDestroyed()) reminderWin.close()
}

export function isReminderVisible(): boolean {
  return !!reminderWin && !reminderWin.isDestroyed() && reminderWin.isVisible()
}
