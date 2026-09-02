import type {
  ItemType,
  ParseSummary,
  Priority,
  SourceType,
  TaskStatus,
  UserRole
} from '@shared/types'

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待确认',
  not_started: '未开始',
  scheduled: '已安排',
  in_progress: '进行中',
  done: '已完成',
  overdue: '已延期',
  ignored: '已忽略'
}

export const TYPE_LABELS: Record<ItemType, string> = {
  deadline: '截止',
  meeting: '会议',
  reminder: '提醒',
  preparation: '准备',
  follow_up: '跟进',
  other: '其他'
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  high: '高',
  medium: '中',
  low: '低',
  unknown: '—'
}

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: '负责人',
  participant: '参与者',
  notified: '被通知',
  helper: '协助',
  unclear: '角色不明'
}

export const SOURCE_LABELS: Record<SourceType, string> = {
  clipboard_text: '剪切板文本',
  clipboard_image: '剪切板图片',
  clipboard_file: '剪切板文件',
  screenshot: '截图',
  file: '文件',
  text_input: '手动输入',
  feishu: '飞书消息',
  screen_scan: '屏幕识别'
}

export function fmtTime(t: string | null | undefined): string {
  if (!t) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return t
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${sameYear ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`
  return `${ymd} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dayKey(t: string | null | undefined): string | null {
  if (!t) return null
  return t.slice(0, 10)
}

export function todayKey(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const IDENTITIES: { value: 'student' | 'worker' | 'freelancer'; label: string; desc: string }[] = [
  { value: 'student', label: '大学生 / 研究生', desc: '课程通知、作业 DDL、导师消息、讲座报名' },
  { value: 'worker', label: '职场新人', desc: '邮件、会议通知、上级安排、项目群消息' },
  { value: 'freelancer', label: '自由职业者', desc: '客户沟通、合同文件、交付与付款节点' }
]

/** 身份类型 → 用户档案字段的呈现。数据模型不变（org/group/workHours 通用字符串），只按身份换标签与占位。 */
export const IDENTITY_PROFILE_FIELDS: Record<
  'student' | 'worker' | 'freelancer',
  {
    org: { label: string; placeholder: string }
    group: { label: string; placeholder: string }
    workHours: { label: string; placeholder: string }
    notMinePlaceholder: string
  }
> = {
  student: {
    org: { label: '学校', placeholder: '如：北京中关村学院' },
    group: { label: '班级 / 课题组', placeholder: '如：2025 级 / 张老师课题组' },
    workHours: { label: '上课 / 科研时间偏好', placeholder: '如：工作日 9:00-22:00，周末补实验' },
    notMinePlaceholder: '如：同门师姐、辅导员群里@别人的通知'
  },
  worker: {
    org: { label: '公司', placeholder: '如：某某科技' },
    group: { label: '部门 / 岗位', placeholder: '如：产品部 / 后端工程师' },
    workHours: { label: '工作时间偏好', placeholder: '如：工作日 10:00-19:00，周三例会' },
    notMinePlaceholder: '如：同事小王、@market、市场部'
  },
  freelancer: {
    org: { label: '主要客户 / 平台', placeholder: '如：某某工作室、接单平台' },
    group: { label: '业务方向', placeholder: '如：UI 设计 / 独立开发' },
    workHours: { label: '接活 / 工作时间偏好', placeholder: '如：晚间为主，周一集中对接客户' },
    notMinePlaceholder: '如：甲方群里@其他供应商的安排'
  }
}

export const CONFIRM_MODES: {
  value: 'conservative' | 'standard' | 'aggressive'
  label: string
  desc: string
}[] = [
  { value: 'conservative', label: '保守', desc: '所有任务都先进入待确认，绝不自动加入日程' },
  { value: 'standard', label: '标准（推荐）', desc: '所有任务进入待确认，高置信度任务高亮提示' },
  {
    value: 'aggressive',
    label: '激进',
    desc: '明确属于你且高置信度的任务自动加入日程，其余进入待确认'
  }
]

/** 目标时间距今天的自然日差（负数表示已过去） */
export function daysUntil(t: string): number {
  const d = new Date(t)
  const now = new Date()
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a.getTime() - b.getTime()) / 86400000)
}

export function countdownLabel(t: string): string {
  const n = daysUntil(t)
  if (Number.isNaN(n)) return ''
  if (n < 0) return `已超期 ${-n} 天`
  if (n === 0) {
    const h = Math.floor((new Date(t).getTime() - Date.now()) / 3600000)
    return h <= 0 ? '今天已过' : `还有 ${h} 小时`
  }
  if (n === 1) return '明天'
  return `还有 ${n} 天`
}

const ACC_SYMBOLS: Record<string, string> = {
  Command: '⌘',
  CommandOrControl: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧'
}

/** Electron accelerator → macOS 风格展示，如 "Command+Shift+K" → "⌘ ⇧ K" */
export function formatHotkey(acc: string): string {
  return acc
    .split('+')
    .map((t) => ACC_SYMBOLS[t] ?? t)
    .join(' ')
}

export function summaryToast(s: ParseSummary): string {
  if (s.error) return `解析失败：${s.error}`
  if (!s.related) {
    return s.duplicates
      ? `内容与已有任务重复，已跳过 ${s.duplicates} 个`
      : '解析完成，未发现与你相关的事项'
  }
  return `发现 ${s.related} 个可能与你有关的事项${
    s.autoAdded ? `，其中 ${s.autoAdded} 个已自动加入日程` : '，已进入待确认'
  }${s.duplicates ? `；另跳过 ${s.duplicates} 个重复任务` : ''}`
}

/** 任务级提醒提前量下拉。'' = 跟随全局默认；-1 = 该任务不提醒。 */
export const REMIND_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '跟随默认' },
  { value: '0', label: '到点提醒' },
  { value: '5', label: '提前 5 分钟' },
  { value: '15', label: '提前 15 分钟' },
  { value: '30', label: '提前 30 分钟' },
  { value: '60', label: '提前 1 小时' },
  { value: '-1', label: '不提醒' }
]

export const remindToInput = (value: number | null): string => (value == null ? '' : String(value))
export const remindFromInput = (value: string): number | null => (value === '' ? null : Number(value))

// ---------- 引导页/个人页的 Tab 补全 ----------

/** 从 placeholder 取出可直接填进输入框的示例值：去掉「如：」这类引导词。
 *  不剥的话用户档案里会存进「如：北京中关村学院」。 */
export function placeholderExample(placeholder: string): string {
  return placeholder.replace(/^如\s*[：:]\s*/, '').trim()
}

/**
 * Tab 补全当前输入框：示例是灰的，用户看得见却打不出来，Tab 填进去比手敲一遍快。
 *
 * 只在**输入框还空着**时接管；已经打了字就放行 Tab 的默认行为（跳下一个框）——
 * 否则用户填到一半按 Tab 会被示例整个覆盖掉。Shift+Tab 一律放行，那是往回跳。
 */
export function fillFromPlaceholder(
  e: { key: string; shiftKey: boolean; preventDefault: () => void },
  value: string,
  placeholder: string,
  set: (v: string) => void
): void {
  if (e.key !== 'Tab' || e.shiftKey || value.trim()) return
  const example = placeholderExample(placeholder)
  if (!example) return
  e.preventDefault()
  set(example)
}
