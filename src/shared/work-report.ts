// 工作日报纯函数：日键/时长格式化/任务切分/日报生成提示词。纯函数 + 注入数据，便于单测与主进程复用。
import type { AppUsageEntry, TaskRecord, WorkRecord } from './types'

/** 本地时区的 YYYY-MM-DD（work_records/app_usage/reports 的日键） */
export function dayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 秒 → 「N 小时 M 分钟」人话（<60s 显示秒） */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

export function defaultReportTitle(day: string): string {
  return `${day} 工作日报`
}

/** 从全部任务切出「这一天完成的」与「仍待办的」标题（日报素材；待办作明日计划候选）。 */
export function splitTasksForDay(tasks: TaskRecord[], day: string): { done: string[]; open: string[] } {
  const OPEN = new Set(['not_started', 'scheduled', 'in_progress', 'overdue'])
  const done = tasks
    .filter((t) => t.status === 'done' && t.updatedAt.slice(0, 10) === day)
    .map((t) => t.title)
    .slice(0, 30)
  const open = tasks
    .filter((t) => OPEN.has(t.status) && t.belongsToUser !== 'no')
    .map((t) => t.title)
    .slice(0, 15)
  return { done, open }
}

export interface ReportMaterial {
  day: string
  records: WorkRecord[]
  usage: AppUsageEntry[]
  tasksDone: string[]
  tasksOpen: string[]
}

/** 拼日报生成的 系统提示词 + 用户内容。只依据给定数据，不让模型编造。 */
export function buildDailyReportPrompt(
  userName: string,
  m: ReportMaterial
): { instructions: string; text: string } {
  const instructions = `你是${userName}的工作日报撰写助手。基于给定的工作记录时间线、应用使用时长与任务数据，用第一人称撰写一份 Markdown 格式的工作日报。
要求：
- 结构依次为：## 今日概览（2~3 句总结）、## 主要工作（把时间线上的记录按事项归并、合并同类项后条目化）、## 完成事项（来自已完成任务；没有则省略本节）、## 时间分配（主要应用及时长，一行一条；没有则省略本节）、## 明日计划（从待办任务中挑 3~5 条最要紧的；没有则省略本节）
- 只依据给定数据组织内容，不要编造不存在的工作
- 语言简洁专业，条目以「- 」开头
- 只输出 Markdown 正文，不要输出代码块围栏或其他说明文字`
  const lines = m.records.map(
    (r) => `${r.createdAt.slice(11, 16)} ${r.app ? `[${r.app}] ` : ''}${r.content}`
  )
  const usage = m.usage.slice(0, 10).map((u) => `${u.app}：${formatDuration(u.seconds)}`)
  const text = `# 日期
${m.day}

# 工作记录时间线
${lines.join('\n') || '（无）'}

# 应用使用时长
${usage.join('\n') || '（无）'}

# 今日完成的任务
${m.tasksDone.join('\n') || '（无）'}

# 待办任务（明日计划候选）
${m.tasksOpen.join('\n') || '（无）'}`
  return { instructions, text }
}
