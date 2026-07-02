import { powerMonitor } from 'electron'
import { applyExternalPetSay } from './pet/controller'

// 久坐提醒：连续活跃使用满 50 分钟 → 桌宠气泡「走动一下吧～」。
// 每分钟采样系统闲置时长：本分钟内有过键鼠输入记 1 分钟活跃；连续闲置 ≥5 分钟视为已休息、计时清零。
// 气泡总开关关闭时 applyExternalPetSay 自然静默（计时照走，开回来即恢复提醒）。
const CHECK_MS = 60_000
const ACTIVE_IDLE_MAX_SEC = 90 // 采样时闲置低于此值 → 这一分钟算活跃
const BREAK_IDLE_SEC = 5 * 60
const REMIND_AFTER_MIN = 50

let timer: ReturnType<typeof setInterval> | null = null
let activeMinutes = 0

export function startWellnessReminder(): void {
  stopWellnessReminder()
  timer = setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime()
    if (idle >= BREAK_IDLE_SEC) {
      activeMinutes = 0
      return
    }
    if (idle <= ACTIVE_IDLE_MAX_SEC) activeMinutes++
    if (activeMinutes >= REMIND_AFTER_MIN) {
      activeMinutes = 0 // 提醒后重新计，下一个 50 分钟再提
      applyExternalPetSay('走动一下吧～', 'waiting', { durationMs: 10_000 })
    }
  }, CHECK_MS)
}

export function stopWellnessReminder(): void {
  if (timer) clearInterval(timer)
  timer = null
}
