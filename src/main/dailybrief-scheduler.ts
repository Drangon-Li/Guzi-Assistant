import { Notification } from 'electron'
import { listTasks } from './db'
import { focusMain } from './windows'
import { buildDailyBrief, msUntilDailyTime } from '@shared/daily-brief'

// MVP：固定每天 08:30 推一次今日简报。后续可做成设置项（见 #14 part 3）。
const BRIEF_HOUR = 8
const BRIEF_MIN = 30

let timer: NodeJS.Timeout | null = null

function fire(): void {
  try {
    const brief = buildDailyBrief(listTasks(), new Date())
    if (brief.count > 0 && Notification.isSupported()) {
      const n = new Notification({ title: '纸壳助手 · 今日简报', body: brief.message })
      n.on('click', () => focusMain('timeline'))
      n.show()
    }
  } catch {
    // 简报失败不影响主流程
  }
  schedule() // 滚动到下一天
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(fire, msUntilDailyTime(new Date(), BRIEF_HOUR, BRIEF_MIN))
}

export function startDailyBrief(): void {
  schedule()
}

export function stopDailyBrief(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
