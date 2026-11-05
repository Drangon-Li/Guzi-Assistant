// IPC：活动历史（History）、工作记录、应用时长与分类、个人记忆、日报。
// 通道清单以 src/shared/ipc-channels.ts 为准；这里只是按领域归位的注册。
import { ipcMain } from './register'
import { dialog } from 'electron'
import { writeFileSync } from 'fs'
import {
  addFocusTask,
  appUsageSummary,
  deleteReport,
  deleteWorkRecord,
  appUsageRange,
  getPersonalMemory,
  listAppCategoryOverrides,
  listAppSwitchesSince,
  setAppCategoryOverride,
  hideFocusTask,
  listFocusTaskPrefs,
  listReports,
  listWorkRecords,
  listWorkRecordsSince,
  setPersonalMemory,
  wipeMemory
} from '../db'
import { generateDailyReport } from '../report'
import { refreshBaseMemory, refreshPersonalMemory } from '../personal-memory'
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
} from '../history/service.ts'
import { pickHistoryApps } from '../history/app-picker.ts'
import { clearAllShots, readShotDataUrl } from '../shotvault'
import { broadcast } from '../windows'
import type { HistoryQueryOptions, HistorySearchOptions } from '@shared/history'
import { assertContentEpoch, captureContentEpoch } from '../content-lifecycle'

export function registerActivityIpc(): void {
  ipcMain.handle('memory:read-shot', (_e, id: string) => readShotDataUrl(id))

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
  ipcMain.handle('history:status', () => historyStatus())
  ipcMain.handle('history:recent', (_e, options: HistoryQueryOptions = {}) => historyRecent(options))
  ipcMain.handle('history:search', (_e, options: HistorySearchOptions = {}) => historySearch(options))
  ipcMain.handle('history:summarize', (_e, options: HistoryQueryOptions = {}) => historySummarize(options))
  ipcMain.handle('history:pause', () => pauseHistory())
  ipcMain.handle('history:resume', () => resumeHistory())
  ipcMain.handle('history:clear', () => clearHistory())
  ipcMain.handle('history:delete-range', (_e, options: HistoryQueryOptions) => deleteHistoryRange(options ?? {}))
  ipcMain.handle('history:pick-apps', () => pickHistoryApps())
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
  ipcMain.handle('app-usage:summary', (_e, day: string) => appUsageSummary(day))
  ipcMain.handle('reports:generate', async (_e, day: string) => {
    const r = await generateDailyReport(day)
    broadcast('guzi-assistant:reports-updated')
    return r
  })
  ipcMain.handle('reports:list', () => listReports())
  ipcMain.handle('reports:delete', (_e, id: string) => deleteReport(id))
  ipcMain.handle('report:export', async (_e, r: { title: string; content: string }) => {
    const epoch = captureContentEpoch()
    const res = await dialog.showSaveDialog({
      title: '导出日报',
      defaultPath: `${r.title}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return false
    assertContentEpoch(epoch)
    writeFileSync(res.filePath, r.content, 'utf8')
    return true
  })
}
