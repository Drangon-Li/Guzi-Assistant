import { dialog, shell } from 'electron'
import { writeFileSync } from 'fs'
import { buildIcs } from '@shared/ics'
import type { TaskRecord } from '@shared/types'
import { assertContentEpoch, captureContentEpoch } from './content-lifecycle'

export interface IcsExportResult {
  ok: boolean
  canceled?: boolean
  error?: string
}

/** 把单个任务导出成 .ics，弹原生保存框，存盘后交系统默认日历 App 打开导入 */
export async function exportTaskIcs(task: TaskRecord): Promise<IcsExportResult> {
  const epoch = captureContentEpoch()
  const ics = buildIcs(task)
  if (!ics) return { ok: false, error: '该任务没有时间，无法生成日历事件' }

  const safe = task.title.replace(/[\\/:*?"<>|\n]/g, '_').trim().slice(0, 60) || 'event'
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出到日历',
    defaultPath: `${safe}.ics`,
    filters: [{ name: 'iCalendar', extensions: ['ics'] }]
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  assertContentEpoch(epoch)

  try {
    writeFileSync(filePath, ics, 'utf-8')
    void shell.openPath(filePath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
