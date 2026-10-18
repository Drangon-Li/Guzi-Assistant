// 注意力分析纯函数：把切换事件/应用时长/工作记录聚合成分析页指标。纯函数 + 注入数据，便于单测。
//
// 指标依据（调研结论，强证据优先）：
// - 平均专注时长基准 47 秒：Mark, Iqbal, Czerwinski et al., CHI 2016（后台日志客观测量，多团队复现 44~50s）
// - 切换有实测成本：Rubinstein, Meyer & Evans 2001, JEP:HPP（不量化具体损失百分比）
// - 专注质量分：RescueTime Productivity Pulse 公开公式（业界口径，非学术）
// - 深度工作段 ≥15 分钟：Rize.io focus session 的工程口径 + Newport《Deep Work》
// - 刻意不用：「中断后 23分15秒恢复」（查无原始论文）、「90 分钟节律提升 40%」（疑似杜撰）
import type {
  AppCategory,
  AppCategoryOverride,
  AppSwitchRecord,
  AppUsageEntry,
  WorkRecord
} from './types'
import { normalizeTaskKey, workRecordInterval, workIntervalsActiveMs } from './work-report.ts'

/** 大众平均屏幕注意力持续时长基准（秒），Mark et al. CHI 2016。 */
export const ATTENTION_BASELINE_SEC = 47

// 默认分类规则：应用名小写子串匹配。覆盖不了的走 neutral，用户可在分析页手动覆盖。
const PRODUCTIVE_PATTERNS = [
  'code',
  'xcode',
  'intellij',
  'pycharm',
  'webstorm',
  'goland',
  'clion',
  'android studio',
  'cursor',
  'terminal',
  'iterm',
  'warp',
  'notion',
  'obsidian',
  'typora',
  'word',
  'excel',
  'powerpoint',
  'keynote',
  'pages',
  'numbers',
  'figma',
  'sketch',
  'matlab',
  'rstudio',
  'jupyter',
  'overleaf',
  'zotero',
  'sublime',
  'vim',
  'emacs',
  '语雀',
  'wps',
  // 设计/创作
  'photoshop',
  'illustrator',
  'indesign',
  'affinity',
  'procreate',
  'blender',
  'canva',
  '即时设计',
  // 视频/音频创作
  'final cut',
  'premiere',
  'after effects',
  'davinci',
  '剪映',
  'logic pro',
  // 写作/笔记/学术
  'scrivener',
  'ulysses',
  'bear',
  'craft',
  'goodnotes',
  'notability',
  'marginnote',
  'endnote',
  'mendeley',
  'texshop',
  'texstudio',
  'texifier',
  'flomo',
  // 学术阅读器（自家产品）
  '谷子学术'
]
const DISTRACTING_PATTERNS = [
  'bilibili',
  'youtube',
  'netflix',
  '优酷',
  '爱奇艺',
  '腾讯视频',
  '抖音',
  'douyin',
  'tiktok',
  '小红书',
  '微博',
  'weibo',
  'steam',
  'epic games',
  '王者',
  '原神',
  'twitch',
  'spotify',
  '网易云音乐',
  'music'
]

/** 覆盖表：应用名（原样）→ 分类。 */
export function buildOverrideMap(list: AppCategoryOverride[]): Map<string, AppCategory> {
  return new Map(list.map((o) => [o.app, o.category]))
}

/** 应用生产力分类：用户覆盖 > 默认规则 > 中性。 */
export function categoryOf(app: string, overrides: Map<string, AppCategory>): AppCategory {
  const hit = overrides.get(app)
  if (hit) return hit
  const f = app.toLowerCase()
  if (PRODUCTIVE_PATTERNS.some((p) => f.includes(p))) return 'productive'
  if (DISTRACTING_PATTERNS.some((p) => f.includes(p))) return 'distracting'
  return 'neutral'
}

/** 平均专注时长（秒）= 活跃时长 / (切换次数 + 1)。无活跃数据 → null。 */
export function avgAttentionSpanSec(activeSeconds: number, switchCount: number): number | null {
  if (activeSeconds <= 0) return null
  return Math.round(activeSeconds / (switchCount + 1))
}

/**
 * 专注质量分 0-100：RescueTime Productivity Pulse 公式的三级简化——
 * 分数 = Σ(时长×权重) / (总时长×4) × 100，权重 专注4 / 中性2 / 分心0。无数据 → null。
 */
export function focusScore(
  usage: AppUsageEntry[],
  cat: (app: string) => AppCategory
): number | null {
  const total = usage.reduce((n, u) => n + u.seconds, 0)
  if (!total) return null
  const WEIGHT: Record<AppCategory, number> = { productive: 4, neutral: 2, distracting: 0 }
  const weighted = usage.reduce((n, u) => n + u.seconds * WEIGHT[cat(u.app)], 0)
  return Math.round((weighted / (total * 4)) * 100)
}

/** 一段连续的专注类应用工作（深度工作/最长专注块的共同素材）。 */
export interface FocusRun {
  start: string
  end: string
  seconds: number
}

/**
 * 专注段（前台应用切换口径）：toApp 的连续前台区间中，专注类应用、相邻间隙 ≤ gapMinutes 归并为一段
 * （短暂切去回消息可归组，但不计入专注时长）。有限终点优先取 heartbeat 投影 endTs；
 * 旧切换记录仅使用已发生的下一事件收尾，缺少终点的末条不延伸到现在。
 */
export function productiveRunsFromSwitches(
  switches: AppSwitchRecord[],
  cat: (app: string) => AppCategory,
  gapMinutes = 10,
  _nowMs = Date.now()
): FocusRun[] {
  const sorted = [...switches].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  const runs: FocusRun[] = []
  let start = ''
  let end = ''
  let activeMs = 0
  let endMs = 0
  const flush = (): void => {
    if (!start) return
    runs.push({ start, end, seconds: Math.max(0, Math.round(activeMs / 1000)) })
    start = ''
  }
  for (let i = 0; i < sorted.length; i++) {
    const intervalStartMs = Date.parse(sorted[i].ts)
    const intervalEndMs = sorted[i].endTs ? Date.parse(sorted[i].endTs!) : i + 1 < sorted.length ? Date.parse(sorted[i + 1].ts) : intervalStartMs
    if (!sorted[i].toApp) { flush(); continue }
    if (!Number.isFinite(intervalStartMs) || !Number.isFinite(intervalEndMs) || intervalEndMs <= intervalStartMs) continue
    if (cat(sorted[i].toApp) !== 'productive') continue
    if (sorted[i].fromApp == null) flush()
    if (start && intervalStartMs - endMs <= gapMinutes * 60_000) {
      if (intervalEndMs > endMs) {
        activeMs += Math.min(sorted[i].activeMs ?? intervalEndMs - intervalStartMs,
          Math.max(0, intervalEndMs - Math.max(endMs, intervalStartMs)))
        end = sorted[i].endTs ?? sorted[i + 1]?.ts ?? sorted[i].ts
        endMs = intervalEndMs
      }
      continue
    }
    flush()
    start = sorted[i].ts
    end = sorted[i].endTs ?? sorted[i + 1]?.ts ?? sorted[i].ts
    activeMs = Math.min(sorted[i].activeMs ?? intervalEndMs - intervalStartMs, intervalEndMs - intervalStartMs)
    endMs = intervalEndMs
  }
  flush()
  return runs
}

/**
 * 专注段：工作记录中专注类应用的连续段（相邻间隔 ≤ gapMinutes）。
 * History 记录使用真实 startAt/endAt；旧记录才保留一条记录约 1 分钟的兼容口径。
 * 注意：依赖模型归类成功才有记录，低交互活动（阅读）覆盖率低——深度工作统计请用 productiveRunsFromSwitches。
 */
export function productiveRuns(
  records: WorkRecord[],
  cat: (app: string) => AppCategory,
  gapMinutes = 10
): FocusRun[] {
  const sorted = records
    .filter((r) => r.app && cat(r.app) === 'productive')
    .map((record) => ({ record, interval: workRecordInterval(record) }))
    .sort((a, b) => a.interval.startMs - b.interval.startMs || a.record.id.localeCompare(b.record.id))
  const runs: FocusRun[] = []
  let start = ''
  let end = ''
  let intervals: ReturnType<typeof workRecordInterval>[] = []
  let endMs = 0
  const flush = (): void => {
    if (!start) return
    runs.push({
      start,
      end,
      seconds: Math.round(workIntervalsActiveMs(intervals) / 1000)
    })
    start = ''
  }
  for (const { interval } of sorted) {
    if (start && interval.startMs - endMs <= gapMinutes * 60_000) {
      intervals.push(interval)
      if (interval.endMs > endMs) {
        end = interval.end
        endMs = interval.endMs
      }
      continue
    }
    flush()
    start = interval.start
    end = interval.end
    intervals = [interval]
    endMs = interval.endMs
  }
  flush()
  return runs
}

/** 深度工作时长（秒）：≥ minMinutes 的专注段求和（Rize 口径的简化：15 分钟阈值）。 */
export function deepWorkSeconds(runs: FocusRun[], minMinutes = 15): number {
  return runs.filter((r) => r.seconds >= minMinutes * 60).reduce((n, r) => n + r.seconds, 0)
}

/** 深度工作块数：≥ minMinutes 的专注段个数。 */
export function deepBlockCount(runs: FocusRun[], minMinutes = 15): number {
  return runs.filter((r) => r.seconds >= minMinutes * 60).length
}

/** 最长专注块（秒）；无段 → 0。 */
export function longestRunSeconds(runs: FocusRun[]): number {
  return runs.reduce((n, r) => Math.max(n, r.seconds), 0)
}

/**
 * 任务切换次数：按时间排序的带任务标签记录中，相邻任务标签不同的次数。
 * 概览卡用它替代「应用切换 N 百次」——量级小、有语义（查资料切浏览器不算切任务），不制造焦虑。
 */
export function taskSwitchCount(records: WorkRecord[]): number {
  const tasks = records
    .filter((r) => !!r.task && normalizeTaskKey(r.task).length > 0)
    .sort((a, b) => workRecordInterval(a).startMs - workRecordInterval(b).startMs)
    .map((r) => normalizeTaskKey(r.task!))
  let n = 0
  for (let i = 1; i < tasks.length; i++) if (tasks[i] !== tasks[i - 1]) n++
  return n
}

/** 每小时切换次数（长度 24），碎片化热力条用。 */
export function hourlySwitches(switches: AppSwitchRecord[]): number[] {
  const byHour = Array<number>(24).fill(0)
  for (const s of switches) {
    if (!s.toApp || !s.fromApp || s.toApp === s.fromApp) continue
    const h = Number(s.ts.slice(11, 13))
    if (h >= 0 && h < 24) byHour[h]++
  }
  return byHour
}

/**
 * 短停留占比：相邻切换间隔 < shortMinutes 的比例（按次数算，规避 idle 把时长口径撑大）。
 * 自定义口径（attention fragmentation 概念来自 Gloria Mark，算法为本项目定义）。切换 <2 次 → null。
 */
export function shortDwellShare(switches: AppSwitchRecord[], shortMinutes = 2): number | null {
  switches = switches.filter((s) => s.toApp && s.fromApp && s.toApp !== s.fromApp)
  if (switches.length < 2) return null
  let short = 0
  for (let i = 1; i < switches.length; i++) {
    const gap = new Date(switches[i].ts).getTime() - new Date(switches[i - 1].ts).getTime()
    if (gap < shortMinutes * 60_000) short++
  }
  return short / (switches.length - 1)
}
