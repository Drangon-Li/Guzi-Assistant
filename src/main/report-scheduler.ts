import { Notification } from 'electron'
import { getSettings } from './db'
import { generateDailyReport } from './report'
import { broadcast, focusMain } from './windows'
import { msUntilDailyTime } from '@shared/daily-brief'
import { dayKey } from '@shared/work-report'

let timer: NodeJS.Timeout | null = null
let scheduleGeneration = 0

export function stopReportSchedule(): void {
  scheduleGeneration += 1
  if (timer) clearTimeout(timer)
  timer = null
}

/** 跟随 dailyReportTime 设置启停每日定时日报（由 applyScreenSenseSettings 在启动/存设置时调用）。 */
export function applyReportSchedule(): void {
  stopReportSchedule()
  const m = /^(\d{1,2}):(\d{2})$/.exec(getSettings().dailyReportTime)
  if (!m) return
  const hh = Math.min(23, Number(m[1]))
  const mm = Math.min(59, Number(m[2]))
  timer = setTimeout(() => void fire(), msUntilDailyTime(new Date(), hh, mm))
}

async function fire(): Promise<void> {
  const generation = scheduleGeneration
  try {
    const report = await generateDailyReport(dayKey(new Date()))
    broadcast('guzi-assistant:reports-updated')
    if (Notification.isSupported()) {
      const n = new Notification({ title: '谷子助手 · 日报已生成', body: report.title })
      n.on('click', () => focusMain('reports'))
      n.show()
    }
  } catch {
    // 当天没记录/未登录等：静默跳过，明天再试
  }
  if (generation === scheduleGeneration) applyReportSchedule()
}
