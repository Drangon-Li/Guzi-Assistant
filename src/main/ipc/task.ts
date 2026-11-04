// IPC：任务、来源原文、提醒卡与助手对话。
// 通道清单以 src/shared/ipc-channels.ts 为准；这里只是按领域归位的注册。
import { ipcMain } from './register'
import {
  bulkUpdateStatus,
  confirmTasks,
  clearChatMessages,
  listChatMessages,
  saveChatMessages,
  deleteSourceContent,
  deleteTask,
  getProfile,
  getSource,
  getTask,
  listTasks,
  saveProfile,
  setTaskSnooze,
  updateTask
} from '../db'
import { learnNotMine } from '@shared/belonging-learn'
import { HINTS } from '../capture'
import { parseToItems } from '../parser'
import { assistantAdd, assistantChat, notifyQuickChatResult } from '../assistant'
import { exportTaskIcs } from '../export'
import type { CandidateContext, ChatHistoryItem, ParsedItem } from '@shared/parsing'
import { deleteShot } from '../shotvault'
import { broadcast, broadcastExcept, focusMain } from '../windows'
import { applyExternalPetReaction, clearPetPersistentSay } from '../pet/controller'
import { hideReminderWindow, resizeReminder } from '../reminder-window'
import { localIso } from '@shared/task-reminder'
import { isQuickBarVisible } from '../quickbar'
import type { TaskRecord, TaskStatus } from '@shared/types'
import { assertContentEpoch, captureContentEpoch } from '../content-lifecycle'

const STATUSES: TaskStatus[] = [
  'pending',
  'not_started',
  'scheduled',
  'in_progress',
  'done',
  'overdue',
  'ignored'
]

export function registerTaskIpc(): void {
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
  ipcMain.handle('tasks:confirm', (_e, ids: string[]) => {
    confirmTasks(ids)
    broadcast('guzi-assistant:tasks-updated')
  })
  ipcMain.handle('tasks:delete', (_e, id: string) => {
    deleteTask(String(id))
    broadcast('guzi-assistant:tasks-updated')
  })

  ipcMain.handle('source:get', (_e, id: string) => getSource(id))
  ipcMain.handle('source:delete', (_e, id: string) => {
    deleteSourceContent(id)
    deleteShot(id) // 删来源原文时一并删其加密截图
    broadcast('guzi-assistant:tasks-updated')
  })
  // 检测卡「备注」：存反馈（注入后续提示词）+「不是我的」语义顺带走归属学习 + 关闭该检测
  // 日程页悬浮加号·自然语言快建：解析后强制归属本人直接入库（用户亲手输入，无需再走确认流）
  ipcMain.handle('tasks:quick-add', async (_e, text: string) => {
    const epoch = captureContentEpoch()
    const hint = `${HINTS.text_input}\n这是用户在日程页为自己手动创建的日程/待办（belongs_to_user 一律填 yes），请尽量解析出明确时间。`
    const items = await parseToItems({ text, hint })
    assertContentEpoch(epoch)
    for (const item of items)
      assistantAdd({
        sourceText: `手动创建：${text.slice(0, 200)}`,
        item: { ...item, belongs_to_user: 'yes' },
        force: true
      })
    broadcast('guzi-assistant:tasks-updated')
    return { added: items.length, titles: items.map((i) => i.title) }
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
      const epoch = captureContentEpoch()
      const res = await assistantChat(payload)
      assertContentEpoch(epoch)
      if (!isQuickBarVisible()) {
        const lastUserText = [...payload.history].reverse().find((m) => m.role === 'user')?.content ?? ''
        notifyQuickChatResult(res, lastUserText)
      }
      return res
    }
  )
  ipcMain.handle(
    'assistant:add',
    (_e, payload: { sourceText: string; item: ParsedItem; force?: boolean }) => assistantAdd(payload)
  )
  ipcMain.handle('chat:history', (_e, scope: string) => listChatMessages(scope))
  ipcMain.handle('chat:save', (e, scope: string, msgs: unknown[]) => {
    saveChatMessages(scope, msgs)
    broadcastExcept(e.sender.id, 'guzi-assistant:chat-updated', { scope })
  })
  ipcMain.handle('chat:clear', (e, scope: string) => {
    clearChatMessages(scope)
    broadcastExcept(e.sender.id, 'guzi-assistant:chat-updated', { scope })
  })

  ipcMain.handle('task:export-ics', (_e, task: TaskRecord) => exportTaskIcs(task))
}
