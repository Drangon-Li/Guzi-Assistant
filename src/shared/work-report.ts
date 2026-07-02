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

/** HH:mm（从 "YYYY-MM-DDTHH:mm" 取） */
function hhmm(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : ''
}

/** 一段连续活动：某时段用户在做什么（工作记录聚合的展示单元）。 */
export interface WorkPeriod {
  start: string // 起始记录的 createdAt
  end: string // 末条记录的 createdAt
  app: string | null
  /** 该时段代表性描述（组内出现最多的内容，并列取最长） */
  summary: string
  /** 组内记录条数 */
  count: number
  /** 时段内的不同活动描述（去重，按首次出现序） */
  activities: string[]
  /** 组内所有记录 id（供整段删除） */
  ids: string[]
}

/**
 * 把逐条工作记录聚合成「时段」：相邻记录同应用且时间间隔 ≤ gapMinutes 分钟 → 并入同一段。
 * 解决「每个时间点各记一条」过碎的问题，改为「某时段在做什么」。纯函数，注入 records。
 */
export function groupWorkPeriods(records: WorkRecord[], gapMinutes = 10): WorkPeriod[] {
  const sorted = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const periods: WorkPeriod[] = []
  let cur: WorkRecord[] = []

  const flush = (): void => {
    if (!cur.length) return
    const counts = new Map<string, number>()
    for (const r of cur) counts.set(r.content, (counts.get(r.content) ?? 0) + 1)
    let summary = cur[0].content
    let best = -1
    for (const [content, n] of counts) {
      if (n > best || (n === best && content.length > summary.length)) {
        best = n
        summary = content
      }
    }
    periods.push({
      start: cur[0].createdAt,
      end: cur[cur.length - 1].createdAt,
      app: cur[0].app,
      summary,
      count: cur.length,
      activities: [...new Set(cur.map((r) => r.content))],
      ids: cur.map((r) => r.id)
    })
    cur = []
  }

  for (const r of sorted) {
    if (cur.length) {
      const prev = cur[cur.length - 1]
      const gapMs = new Date(r.createdAt).getTime() - new Date(prev.createdAt).getTime()
      const sameApp = (r.app ?? '') === (prev.app ?? '')
      if (!sameApp || gapMs > gapMinutes * 60_000) flush()
    }
    cur.push(r)
  }
  flush()
  return periods
}

/** 时段标签：起止相同显示单点，否则 "HH:mm–HH:mm"。 */
export function periodLabel(p: WorkPeriod): string {
  const s = hhmm(p.start)
  const e = hhmm(p.end)
  return s === e ? s : `${s}–${e}`
}

/**
 * 近期行为画像生成 prompt：从近期工作记录 + 任务归纳「用户最近在做什么、关注什么」。
 * 与「基本画像」分工：基本画像是用户身份的长期定义（手动维护），这里只写近期任务与关注点。
 */
export function buildPersonalMemoryPrompt(
  userName: string,
  activityLines: string[],
  taskTitles: string[],
  prevMemory: string,
  baseMemory = ''
): { instructions: string; text: string } {
  const instructions = `你在为个人助手维护用户「${userName}」的**近期行为画像**：基于其近期工作活动与任务，归纳 TA 最近在推进哪些任务/项目、关注什么、和谁协作。
要求：
- 输出 4~8 条要点，每条一句话，以「- 」开头；只写能从数据里稳定看出的事实与倾向，不臆测
- 只写**近期**的任务与关注点；用户的长期身份定义已在「基本画像」里，不要复述它
- 若给了「已有近期画像」，在其基础上更新演进：保留仍在进行的、修订过时的、补充新出现的
- 只输出画像正文，不要标题、不要代码块围栏、不要多余说明`
  const text = `# 用户
${userName}

# 基本画像（背景参考，勿复述）
${baseMemory.trim() || '（无）'}

# 已有近期画像
${prevMemory.trim() || '（无，首次生成）'}

# 近期工作活动（按时段）
${activityLines.join('\n') || '（无）'}

# 近期任务
${taskTitles.join('\n') || '（无）'}`
  return { instructions, text }
}

/**
 * 任务专注时长：按 task 标签把记录切成连续段（同任务、相邻间隔 ≤gapMinutes），
 * 每段时长 = 末条-首条 + 1 分钟（单条记录也算 1 分钟专注）。返回按累计时长降序。
 */
export function focusDurations(
  records: WorkRecord[],
  gapMinutes = 15
): { task: string; seconds: number }[] {
  const sorted = records
    .filter((r) => r.task)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const total = new Map<string, number>()
  let runTask: string | null = null
  let runStart = ''
  let runEnd = ''
  const flush = (): void => {
    if (!runTask) return
    const span = (new Date(runEnd).getTime() - new Date(runStart).getTime()) / 1000 + 60
    total.set(runTask, (total.get(runTask) ?? 0) + span)
    runTask = null
  }
  for (const r of sorted) {
    const task = r.task!
    if (
      runTask === task &&
      new Date(r.createdAt).getTime() - new Date(runEnd).getTime() <= gapMinutes * 60_000
    ) {
      runEnd = r.createdAt
      continue
    }
    flush()
    runTask = task
    runStart = r.createdAt
    runEnd = r.createdAt
  }
  flush()
  return [...total.entries()]
    .map(([task, seconds]) => ({ task, seconds: Math.round(seconds) }))
    .sort((a, b) => b.seconds - a.seconds)
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
  // 用时段而非逐条喂模型：更贴近「某时段在做什么」，也省 token
  const lines = groupWorkPeriods(m.records).map((p) => {
    const extra = p.activities.length > 1 ? `（含 ${p.activities.length} 项活动）` : ''
    return `${periodLabel(p)} ${p.app ? `[${p.app}] ` : ''}${p.summary}${extra}`
  })
  const usage = m.usage.slice(0, 10).map((u) => `${u.app}：${formatDuration(u.seconds)}`)
  const text = `# 日期
${m.day}

# 工作记录时间线（按时段聚合）
${lines.join('\n') || '（无）'}

# 应用使用时长
${usage.join('\n') || '（无）'}

# 今日完成的任务
${m.tasksDone.join('\n') || '（无）'}

# 待办任务（明日计划候选）
${m.tasksOpen.join('\n') || '（无）'}`
  return { instructions, text }
}
