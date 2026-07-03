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
  'wps'
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
 * 专注段：工作记录中专注类应用的连续段（相邻间隔 ≤ gapMinutes），
 * 段时长 = 末条-首条 + 1 分钟（单条也算 1 分钟，与 focusDurations 口径一致）。
 */
export function productiveRuns(
  records: WorkRecord[],
  cat: (app: string) => AppCategory,
  gapMinutes = 10
): FocusRun[] {
  const sorted = records
    .filter((r) => r.app && cat(r.app) === 'productive')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const runs: FocusRun[] = []
  let start = ''
  let end = ''
  const flush = (): void => {
    if (!start) return
    runs.push({
      start,
      end,
      seconds: Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000 + 60)
    })
    start = ''
  }
  for (const r of sorted) {
    if (start && new Date(r.createdAt).getTime() - new Date(end).getTime() <= gapMinutes * 60_000) {
      end = r.createdAt
      continue
    }
    flush()
    start = r.createdAt
    end = r.createdAt
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
    .filter((r) => r.task)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => r.task)
  let n = 0
  for (let i = 1; i < tasks.length; i++) if (tasks[i] !== tasks[i - 1]) n++
  return n
}

/** 每小时切换次数（长度 24），碎片化热力条用。 */
export function hourlySwitches(switches: AppSwitchRecord[]): number[] {
  const byHour = Array<number>(24).fill(0)
  for (const s of switches) {
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
  if (switches.length < 2) return null
  let short = 0
  for (let i = 1; i < switches.length; i++) {
    const gap = new Date(switches[i].ts).getTime() - new Date(switches[i - 1].ts).getTime()
    if (gap < shortMinutes * 60_000) short++
  }
  return short / (switches.length - 1)
}
