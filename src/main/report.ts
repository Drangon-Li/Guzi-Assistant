import { addReport, appUsageSummary, getProfile, listTasks, listWorkRecords } from './db'
import { callModel } from './parser'
import { buildDailyReportPrompt, defaultReportTitle, splitTasksForDay } from '@shared/work-report'
import type { ReportRecord } from '@shared/types'

/** 生成某天（YYYY-MM-DD）的工作日报：当日工作记录 + 应用时长 + 任务完成情况 → 云端撰写 Markdown。 */
export async function generateDailyReport(day: string): Promise<ReportRecord> {
  const profile = getProfile()
  if (!profile) throw new Error('尚未完成用户档案设置')
  const records = listWorkRecords(day)
  const usage = appUsageSummary(day)
  const { done, open } = splitTasksForDay(listTasks(), day)
  if (!records.length && !done.length && !usage.length)
    throw new Error('这一天还没有工作记录，开启屏幕感知或完成任务后再来生成')
  const { instructions, text } = buildDailyReportPrompt(profile.name, {
    day,
    records,
    usage,
    tasksDone: done,
    tasksOpen: open
  })
  const output = await callModel(
    instructions,
    [{ role: 'user', content: [{ type: 'input_text', text }] }],
    'parse_text'
  )
  // 模型偶尔无视指令包一层代码块围栏，剥掉
  const content = output
    .trim()
    .replace(/^```(?:markdown)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
  if (!content) throw new Error('日报生成失败：模型无输出')
  return addReport({ day, title: defaultReportTitle(day), content })
}
