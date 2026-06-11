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
  text_input: '手动输入'
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

export const CONFIRM_MODES: {
  value: 'conservative' | 'standard' | 'aggressive'
  label: string
  desc: string
}[] = [
  { value: 'conservative', label: '保守', desc: '所有任务都进入待确认收件箱，绝不自动加入日程' },
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
    s.autoAdded ? `，其中 ${s.autoAdded} 个已自动加入日程` : '，已进入待确认收件箱'
  }${s.duplicates ? `；另跳过 ${s.duplicates} 个重复任务` : ''}`
}
