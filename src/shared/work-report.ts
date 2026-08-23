// 工作日报纯函数：日键/时长格式化/任务切分/日报生成提示词。纯函数 + 注入数据，便于单测与主进程复用。
import type { AppUsageEntry, TaskRecord, WorkRecord, WorkRecordSource } from './types'

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

/** Work records before History v2 only had createdAt; keep their one-minute fallback. */
export function workRecordStart(record: Pick<WorkRecord, 'createdAt'> & Partial<Pick<WorkRecord, 'startAt'>>): string {
  return record.startAt ?? record.createdAt
}

export function workRecordEnd(record: Pick<WorkRecord, 'createdAt'> & Partial<Pick<WorkRecord, 'endAt'>>): string {
  return record.endAt ?? record.createdAt
}

export interface WorkRecordInterval {
  start: string
  end: string
  startMs: number
  endMs: number
}

export function workRecordInterval(record: WorkRecord): WorkRecordInterval {
  const start = workRecordStart(record)
  const rawEnd = workRecordEnd(record)
  const startMs = Number.isFinite(Date.parse(start)) ? Date.parse(start) : 0
  let endMs = Number.isFinite(Date.parse(rawEnd)) ? Date.parse(rawEnd) : startMs
  const explicitHistoryInterval = record.derivedBy === 'history'
  // Legacy records have no real end; preserve the established one-minute
  // report fallback while History-derived records use the exact interval.
  if (!explicitHistoryInterval && endMs <= startMs) endMs = startMs + 60_000
  if (endMs < startMs) endMs = startMs
  return { start, end: rawEnd, startMs, endMs }
}

/** HH:mm（从 "YYYY-MM-DDTHH:mm" 取） */
function hhmm(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : ''
}

/** 一段连续活动：某时段用户在做什么（工作记录聚合的展示单元）。 */
export interface WorkPeriod {
  start: string // 工作区间起点
  end: string // 工作区间终点
  durationSeconds: number
  app: string | null
  /** 该时段代表性描述（组内出现最多的内容，并列取最长） */
  summary: string
  /** 组内记录条数 */
  count: number
  /** 时段内的不同活动描述（去重，按首次出现序） */
  activities: string[]
  /** 组内所有记录 id（供整段删除） */
  ids: string[]
  source: WorkRecordSource
}

/**
 * 把逐条工作记录聚合成「时段」：相邻记录同应用、同任务且时间间隔 ≤ gapMinutes 分钟 → 并入同一段。
 * 解决「每个时间点各记一条」过碎的问题，改为「某时段在做什么」。纯函数，注入 records。
 */
export function groupWorkPeriods(records: WorkRecord[], gapMinutes = 10): WorkPeriod[] {
  const sorted = [...records]
    .map((record) => ({ record, interval: workRecordInterval(record) }))
    .sort((a, b) => a.interval.startMs - b.interval.startMs || a.record.id.localeCompare(b.record.id))
  const periods: WorkPeriod[] = []
  let cur: { record: WorkRecord; interval: WorkRecordInterval }[] = []

  const flush = (): void => {
    if (!cur.length) return
    const counts = new Map<string, number>()
    for (const { record: r } of cur) counts.set(r.content, (counts.get(r.content) ?? 0) + 1)
    const sourceCounts = new Map<WorkRecordSource, number>()
    for (const { record: r } of cur) sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1)
    let summary = cur[0].record.content
    let best = -1
    for (const [content, n] of counts) {
      if (n > best || (n === best && content.length > summary.length)) {
        best = n
        summary = content
      }
    }
    periods.push({
      start: cur[0].interval.start,
      end: cur.reduce((latest, item) => item.interval.endMs > latest.interval.endMs ? item : latest).interval.end,
      durationSeconds: Math.max(
        0,
        Math.round(
          (cur.reduce((latest, item) => Math.max(latest, item.interval.endMs), cur[0].interval.startMs) -
            cur[0].interval.startMs) /
            1000
        )
      ),
      app: cur[0].record.app,
      summary,
      count: cur.length,
      activities: [...new Set(cur.map(({ record: r }) => r.content))],
      ids: cur.map(({ record: r }) => r.id),
      source: [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'ocr'
    })
    cur = []
  }

  for (const item of sorted) {
    const interval = item.interval
    if (cur.length) {
      const prev = cur[cur.length - 1]
      const gapMs = interval.startMs - prev.interval.endMs
      const sameApp = (item.record.app ?? '') === (prev.record.app ?? '')
      const sameTask =
        (!item.record.task && !prev.record.task) ||
        (!!item.record.task && !!prev.record.task && normalizeTaskKey(item.record.task) === normalizeTaskKey(prev.record.task))
      if (!sameApp || !sameTask || gapMs > gapMinutes * 60_000) flush()
    }
    cur.push(item)
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

/** Display a real task interval without converting or inventing timestamps. */
export function timeRangeLabel(startAt: string | null | undefined, endAt: string | null | undefined): string {
  if (!startAt || !endAt || !Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) return ''
  const s = hhmm(startAt)
  const e = hhmm(endAt)
  return s === e ? s : `${s}–${e}`
}

/** 一天的六个时段分区（锚点导航用）。深夜跨零点，在单日数据里即 0:00–5:00。 */
export const DAY_SEGMENTS = [
  { key: 'dawn', label: '清晨', from: 5, to: 8 },
  { key: 'morning', label: '上午', from: 8, to: 12 },
  { key: 'noon', label: '中午', from: 12, to: 14 },
  { key: 'afternoon', label: '下午', from: 14, to: 19 },
  { key: 'evening', label: '晚间', from: 19, to: 24 },
  { key: 'night', label: '深夜', from: 0, to: 5 }
] as const

export type DaySegment = (typeof DAY_SEGMENTS)[number]

/** 时间戳（YYYY-MM-DDTHH:mm）落在哪个时段分区。 */
export function daySegmentOf(iso: string): DaySegment {
  const h = Number(iso.slice(11, 13))
  return DAY_SEGMENTS.find((s) => h >= s.from && h < s.to) ?? DAY_SEGMENTS[5]
}

/**
 * 个人记忆的显示格式：存储保持「- 」要点（模型好读、prompt 直接注入），
 * 给用户展示/编辑时转成无 Markdown 的纯文本，保存时再转回要点格式。
 */
export function memoryToPlain(text: string): string {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]|\d+[.、])\s*/, '')
        .replace(/^#+\s*/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .trimEnd()
    )
    .join('\n')
    .trim()
}

/** 纯文本 → 存储格式：每个非空行变成一条「- 」要点。 */
export function plainToMemory(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('- ') ? l : `- ${l}`))
    .join('\n')
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
 * 基本画像生成 prompt：归纳用户的**长期身份定义**（身份/方向/长期项目/工具习惯）。
 * 比近期画像更稳定精简；在用户手写内容基础上小幅演进，不覆盖其自我定义。
 */
export function buildBaseMemoryPrompt(
  userName: string,
  profileDesc: string,
  activityLines: string[],
  taskTitles: string[],
  prevBase: string
): { instructions: string; text: string } {
  const instructions = `你在为个人助手维护用户「${userName}」的**基本画像**：TA 是谁——身份/角色、研究或业务方向、长期在做的项目、常用工具与工作习惯。
要求：
- 输出 3~6 条要点，每条一句话，以「- 」开头；只写长期稳定的事实，不写近期临时任务（那属于近期画像）
- 若给了「已有基本画像」，在其基础上**小幅演进**：用户手写的自我定义保留原意，只修订明显过时、补充明显缺失的
- 只输出画像正文，不要标题、不要代码块围栏、不要多余说明`
  const text = `# 用户档案
${profileDesc || '（无）'}

# 已有基本画像
${prevBase.trim() || '（无，首次生成）'}

# 近期工作活动（推断长期模式的参考）
${activityLines.join('\n') || '（无）'}

# 近期任务（参考）
${taskTitles.join('\n') || '（无）'}`
  return { instructions, text }
}

/**
 * 任务归一键：折叠模型对同一任务偶发的空格/全半角/大小写/标点差异
 * （「评审EMNLP论文」「评审 EMNLP 论文」「评审：ＥＭＮＬＰ论文」视为同一任务）。
 * NFKC 折全角→半角，去掉全部空白与标点（中英混排时模型加不加空格/标点不稳定），小写化英文。
 * 仅作分组/匹配用，展示仍取原始写法（见 focusDurations 的 displayOf）。
 */
export function normalizeTaskKey(name: string): string {
  return name.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

/**
 * 模型偶发给出的「垃圾桶」任务名：没有明确项目/对象的泛化归类（实测「随心输入」曾吞掉大半记录）。
 * 命中即视为无任务——这些名字对专注统计只有噪音。
 */
const GENERIC_FOCUS_TASK_KEYS = new Set(
  [
    '随心输入',
    '随意输入',
    '随便输入',
    '自由输入',
    '日常输入',
    '随意浏览',
    '随便看看',
    '随便浏览',
    '日常浏览',
    '上网冲浪',
    '闲聊',
    '摸鱼',
    '其他',
    '杂项',
    '未分类'
  ].map((name) => normalizeTaskKey(name))
)

/** 判断模型给的任务名是否是无明确对象的泛化名（归一键比较，折叠写法差异）。 */
export function isGenericFocusTask(name: string | null | undefined): boolean {
  if (!name) return false
  return GENERIC_FOCUS_TASK_KEYS.has(normalizeTaskKey(name))
}

/**
 * 自身产品的全部历史/内部名称（与 app_usage 的自身排除清单一致）：
 * 这些名字永远是被使用的工具，不是用户要推进的任务。
 */
const SELF_PRODUCT_NAME_KEYS = new Set(
  ['Electron', 'GuziAssistant', 'Guzi Assistant', 'EShell', 'Gooz', '谷子助手', '纸壳助手'].map((name) =>
    normalizeTaskKey(name)
  )
)

/**
 * 任务名不得是裸 App/产品名（如「谷子助手」「微信」——模型看到内容提到某产品时容易直接拿来当任务）。
 * 命中自身产品名或已知 App 名（归一键精确匹配，不影响「开发谷子助手」这类带动作的合法任务名）即视为无任务。
 */
export function isAppNameTask(name: string | null | undefined, knownApps: readonly string[] = []): boolean {
  if (!name) return false
  const key = normalizeTaskKey(name)
  if (!key) return false
  if (SELF_PRODUCT_NAME_KEYS.has(key)) return true
  return knownApps.some((app) => normalizeTaskKey(app) === key)
}

/**
 * 二级归并：模型对同一任务的措辞漂移不止空格/大小写，还会多出限定词或编号
 * （「论文研读」vs「论文研读与标注」、「论文阅读」vs「论文2505.18966阅读」）。
 * 规则保守两条：① 一个键包含另一个键且短键 ≥4 字符；② 去掉数字后两键相同且 ≥4 字符。
 * 返回 原始归一键 → 归并键 的映射（归并键取组内最长者，更具体）。
 */
export function mergeTaskKeys(keys: string[]): Map<string, string> {
  const parent = new Map<string, string>(keys.map((k) => [k, k]))
  const find = (k: string): string => {
    let root = k
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(k, root)
    return root
  }
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b))
  }
  const stem = (k: string): string => k.replace(/\d+/g, '')
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = keys[i].length <= keys[j].length ? [keys[i], keys[j]] : [keys[j], keys[i]]
      if (a.length >= 4 && b.includes(a)) union(a, b)
      else {
        const s = stem(a)
        if (s.length >= 4 && s === stem(b)) union(a, b)
      }
    }
  }
  const groups = new Map<string, string[]>()
  for (const k of keys) {
    const root = find(k)
    groups.set(root, [...(groups.get(root) ?? []), k])
  }
  const out = new Map<string, string>()
  for (const members of groups.values()) {
    const canonical = [...members].sort((a, b) => b.length - a.length || a.localeCompare(b))[0]
    for (const m of members) out.set(m, canonical)
  }
  return out
}

/** Persist one stable, displayable task label while keeping grouping separate from presentation. */
export function normalizeTaskLabel(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null
  const label = value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max)
  return label || null
}

/**
 * 任务专注时长：按 task 标签把记录切成连续段（同任务、相邻间隔 ≤gapMinutes）。
 * History 记录使用真实 startAt/endAt；旧记录才使用兼容性的 1 分钟回退。返回按累计时长降序。
 * 分组按归一键（见 normalizeTaskKey）再做二级归并（见 mergeTaskKeys）：
 * 空格/标点/大小写差异直接合并，措辞漂移（包含关系、仅数字编号不同）也合并成一个任务；
 * 「随心输入」类泛化名（见 isGenericFocusTask）不参与统计。
 * 展示名取该键下出现最多的原始写法（并列取更长的，空格版更易读）。
 */
export interface FocusDuration {
  task: string
  seconds: number
  /** Earliest and latest real work-record timestamps contributing to this task. */
  startAt: string | null
  endAt: string | null
  /** 该任务归并组内全部写法的归一键（隐藏匹配用：组内任一写法被隐藏即整组隐藏）。 */
  taskKeys: string[]
}

export function focusDurations(
  records: WorkRecord[],
  gapMinutes = 15
): FocusDuration[] {
  const sorted = records
    .filter((r) => !!r.task && normalizeTaskKey(r.task).length > 0 && !isGenericFocusTask(r.task))
    .map((record) => ({ record, interval: workRecordInterval(record) }))
    .sort((a, b) => a.interval.startMs - b.interval.startMs || a.record.id.localeCompare(b.record.id))
  const canonicalKey = mergeTaskKeys([...new Set(sorted.map(({ record: r }) => normalizeTaskKey(r.task!)))])
  const keyOf = (name: string): string => canonicalKey.get(normalizeTaskKey(name)) ?? normalizeTaskKey(name)
  const variants = new Map<string, Map<string, number>>()
  for (const { record: r } of sorted) {
    const key = keyOf(r.task!)
    const m = variants.get(key) ?? new Map<string, number>()
    m.set(r.task!, (m.get(r.task!) ?? 0) + 1)
    variants.set(key, m)
  }
  const displayOf = (key: string): string =>
    [...variants.get(key)!.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0]

  const total = new Map<string, number>()
  const ranges = new Map<string, { startAt: string | null; endAt: string | null; startMs: number; endMs: number }>()
  for (const { record: r, interval } of sorted) {
    const key = keyOf(r.task!)
    const startMs = Date.parse(interval.start)
    const endMs = Date.parse(interval.end)
    const current = ranges.get(key) ?? { startAt: null, endAt: null, startMs: Infinity, endMs: -Infinity }
    if (Number.isFinite(startMs) && startMs < current.startMs) {
      current.startMs = startMs
      current.startAt = interval.start
    }
    if (Number.isFinite(endMs) && endMs > current.endMs) {
      current.endMs = endMs
      current.endAt = interval.end
    }
    ranges.set(key, current)
  }
  let runKey: string | null = null
  let runStartMs = 0
  let runEndMs = 0
  const flush = (): void => {
    if (!runKey) return
    const span = Math.max(0, (runEndMs - runStartMs) / 1000)
    total.set(runKey, (total.get(runKey) ?? 0) + span)
    runKey = null
  }
  for (const { record: r, interval } of sorted) {
    const key = keyOf(r.task!)
    if (
      runKey === key &&
      interval.startMs - runEndMs <= gapMinutes * 60_000
    ) {
      if (interval.endMs > runEndMs) {
        runEndMs = interval.endMs
      }
      continue
    }
    flush()
    runKey = key
    runStartMs = interval.startMs
    runEndMs = interval.endMs
  }
  flush()
  return [...total.entries()]
    .map(([key, seconds]) => ({
      task: displayOf(key),
      seconds: Math.round(seconds),
      startAt: ranges.get(key)?.startAt ?? null,
      endAt: ranges.get(key)?.endAt ?? null,
      taskKeys: [...(variants.get(key)?.keys() ?? [])].map((name) => normalizeTaskKey(name))
    }))
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
    return `${periodLabel(p)} ${p.app ? `[${p.app}] ` : ''}${p.summary}${extra}（${formatDuration(p.durationSeconds)}）`
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
