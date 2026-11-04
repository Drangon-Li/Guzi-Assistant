// 任务提醒调度：30 秒 tick 扫「该提醒的任务」→ 置顶提醒卡 + 桌宠常驻气泡 + 系统通知。
//
// 不给每个任务开 setTimeout：长 timer 在睡眠/时钟跳变后不可靠。30 秒轮询精度对提醒足够，
// 且天然抗休眠；合盖唤醒再补一次 tick 兜住「睡过去的那段」。
import { Notification, powerMonitor } from 'electron'
import type { ReminderCardItem, TaskRecord } from '@shared/types'
import { dueReminders, reminderWhenLabel } from '@shared/task-reminder'
import { getSettings, listReminderCandidates, markTaskReminded } from './db'
import { applyPetPersistentSay } from './pet/controller'
import { showReminders } from './reminder-window'
import { focusMain } from './windows'

const TICK_MS = 30_000
const FIRST_RUN_DELAY_MS = 5_000 // 启动时等窗口/DB 就绪再跑第一轮
const MAX_CARDS_PER_TICK = 5 // 关机数小时后开机也不会弹一屏
const CATCHUP_WINDOW_MIN = 120

let timer: ReturnType<typeof setInterval> | null = null
let firstRun: ReturnType<typeof setTimeout> | null = null
let resumeHooked = false

function tick(): void {
  const settings = getSettings()
  if (!settings.taskReminderEnabled) return

  let tasks: TaskRecord[]
  try {
    tasks = listReminderCandidates()
  } catch {
    return // DB 还没就绪（启动竞态）：下一轮再来
  }
  const due = dueReminders(
    tasks,
    {
      enabled: true,
      defaultOffsetMin: settings.taskReminderOffsetMin,
      catchupWindowMin: CATCHUP_WINDOW_MIN
    },
    new Date()
  )
  if (!due.length) return

  // 先写幂等再展示：展示链路任意一环抛错都不能让下一轮重新命中同一条，
  // 否则会变成每 30 秒刷一次屏。代价是极端情况下丢一次提醒，比刷屏可接受。
  for (const item of due) {
    try {
      markTaskReminded(item.taskId, item.targetIso)
    } catch {
      return
    }
  }

  const byId = new Map(tasks.map((task) => [task.id, task]))
  const shown = due.slice(0, MAX_CARDS_PER_TICK)
  const items: ReminderCardItem[] = []
  for (const reminder of shown) {
    const task = byId.get(reminder.taskId)
    if (!task) continue
    items.push({
      taskId: task.id,
      title: task.title,
      eventIso: reminder.eventIso,
      kind: reminder.kind,
      location: task.location,
      notes: task.notes,
      priority: task.priority
    })
  }
  if (!items.length) return

  const overflow = due.length - items.length
  showReminders({ items, overflow })
  announce(items, overflow)
}

/** 桌宠常驻气泡 + 系统通知。两条都只是「让人注意到」，真正的操作在提醒卡上。 */
function announce(items: ReminderCardItem[], overflow: number): void {
  const total = items.length + overflow
  const first = items[0]
  const body =
    total > 1
      ? `「${first.title}」等 ${total} 件事到点了`
      : `「${first.title}」${reminderWhenLabel(first, new Date())}`

  applyPetPersistentSay(body, 'waiting')

  if (!Notification.isSupported()) return
  // 系统通知是兜底：应用被隐藏、在另一个 Space、或桌宠被关掉时仍能感知到。
  const notification = new Notification({ title: '谷子助手 · 任务提醒', body })
  notification.on('click', () => focusMain('schedule'))
  notification.show()
}

export function startTaskReminder(): void {
  stopTaskReminder()
  firstRun = setTimeout(() => {
    firstRun = null
    tick()
  }, FIRST_RUN_DELAY_MS)
  firstRun.unref?.()
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  if (!resumeHooked) {
    // 合盖唤醒：睡眠期间 interval 不跑，醒来立刻补一轮，否则要等最多 30 秒
    powerMonitor.on('resume', () => {
      if (timer) tick()
    })
    resumeHooked = true
  }
}

export function stopTaskReminder(): void {
  if (timer) clearInterval(timer)
  if (firstRun) clearTimeout(firstRun)
  timer = null
  firstRun = null
}

/** 跟随 taskReminderEnabled 设置启停（存设置时调）。 */
export function applyTaskReminderSchedule(): void {
  if (getSettings().taskReminderEnabled) startTaskReminder()
  else stopTaskReminder()
}
