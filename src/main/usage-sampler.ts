// 前台应用采样（app_usage 时长 + app_switches 切换事件）。
// 与监控轮解耦：只读前台 App 名（NSWorkspace，无需权限、不看屏幕内容、不花钱），
// 所以不受 ticking 守卫/检测卡/未登录/云端退避影响；托盘暂停仍生效——用户暂停即全部暂停。
import { powerMonitor } from 'electron'
import { dayKey } from '@shared/work-report'
import { addAppSwitch, addAppUsage } from './db'
import { getFrontmostContext } from './frontapp'
import {
  markActivityObserverFailure,
  markActivityObserverHealthy,
  recordFrontmostContext
} from './activity-tracker'
import { isOwnApp, privacyForContext } from './privacy'

export const IDLE_SKIP_SEC = 60 // 键鼠闲置超此秒数视为人不在电脑前，整轮跳过（不截图/不统计/不上云）
const SAMPLE_SEC = 5

let sampleTimer: ReturnType<typeof setInterval> | null = null
let sampling = false
let lastSampleAtMs = 0
let systemInactive = false
let lastSwitchApp: string | null = null // 切换事件：上一次采样的前台应用（own-app/idle 轮不更新）
let isPaused: () => boolean = () => false

const markSystemInactive = (): void => {
  systemInactive = true
  lastSampleAtMs = Date.now()
  lastSwitchApp = null
}

const markSystemActive = (): void => {
  systemInactive = false
  lastSampleAtMs = Date.now()
  lastSwitchApp = null
}

async function sampleTick(): Promise<void> {
  if (sampling) return
  sampling = true
  try {
    const now = Date.now()
    if (systemInactive) {
      // 锁屏/睡眠期间不补记；解锁后从新的采样窗口开始。
      lastSampleAtMs = now
      if (powerMonitor.getSystemIdleTime() >= IDLE_SKIP_SEC) return
      systemInactive = false
    }
    // 按真实流逝时间记账，而非名义周期：触发被丢/延迟也不少记；
    // 上限 2 个周期，防睡眠唤醒把整段睡眠补记进来
    const credit = Math.min(Math.round((now - lastSampleAtMs) / 1000), SAMPLE_SEC * 2)
    lastSampleAtMs = now
    if (credit <= 0 || isPaused()) return
    const context = await getFrontmostContext()
    if (systemInactive) return
    if (!context?.name) {
      markActivityObserverFailure('无法读取前台应用上下文')
      return
    }
    markActivityObserverHealthy()
    if (powerMonitor.getSystemIdleTime() >= IDLE_SKIP_SEC) return // 人不在电脑前
    if (systemInactive) return
    const frontApp = context.name
    const ownApp = isOwnApp(frontApp)
    const privacy = privacyForContext(context)
    const { privacyState } = privacy
    recordFrontmostContext(context, {
      suppressed: privacy.suppressed,
      privacyState,
      nowMs: now
    })
    // 自己在前台不计（dev 是 Electron、正式包是谷子助手，统计自己只会污染榜单）；
    // 排除名单 App 照常计时——名单挡的是截图，不是「用了多久」
    if (ownApp) return
    addAppUsage(dayKey(new Date()), frontApp, credit)
    // 切换事件：注意力分析素材（平均专注时长/切换率/碎片化都靠它）
    if (lastSwitchApp && lastSwitchApp !== frontApp) addAppSwitch(lastSwitchApp, frontApp)
    lastSwitchApp = frontApp
  } finally {
    sampling = false
  }
}

export function startUsageSampler(paused: () => boolean): void {
  stopUsageSampler()
  isPaused = paused
  systemInactive = false
  lastSampleAtMs = Date.now()
  powerMonitor.on('suspend', markSystemInactive)
  powerMonitor.on('lock-screen', markSystemInactive)
  powerMonitor.on('shutdown', markSystemInactive)
  powerMonitor.on('resume', markSystemActive)
  powerMonitor.on('unlock-screen', markSystemActive)
  void sampleTick().catch(() => {})
  sampleTimer = setInterval(() => void sampleTick().catch(() => {}), SAMPLE_SEC * 1000)
}

export function stopUsageSampler(): void {
  if (sampleTimer) {
    clearInterval(sampleTimer)
    sampleTimer = null
  }
  powerMonitor.removeListener('suspend', markSystemInactive)
  powerMonitor.removeListener('lock-screen', markSystemInactive)
  powerMonitor.removeListener('shutdown', markSystemInactive)
  powerMonitor.removeListener('resume', markSystemActive)
  powerMonitor.removeListener('unlock-screen', markSystemActive)
  systemInactive = false
  lastSwitchApp = null // 停启之间的间隔不算一次「切换」
}
