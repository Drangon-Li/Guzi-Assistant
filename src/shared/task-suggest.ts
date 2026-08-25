// 「谷子建议」：按时间紧迫度 + 优先级给未完成任务打分排序，纯本地确定性计算（不调模型）。
// 时间字符串沿用库内格式 YYYY-MM-DDTHH:mm（本地时区），可直接字典序比较。
import type { TaskRecord, TaskStatus } from './types'

export interface TaskSuggestion {
  task: TaskRecord
  score: number
  /** 为什么排在这里，展示在任务行上（如「今天截止 · 高优先级」） */
  reasons: string[]
}

export interface SuggestionTier {
  title: string
  items: TaskSuggestion[]
}

const SUGGEST_STATUSES: TaskStatus[] = ['not_started', 'scheduled', 'in_progress', 'overdue']

const HOUR_MS = 60 * 60 * 1000

function refTimeOf(t: TaskRecord): string | null {
  return t.dueTime ?? t.startTime
}

function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

export function rankTaskSuggestions(
  tasks: TaskRecord[],
  nowIso: string,
  opts: { starredTags?: string[] } = {}
): SuggestionTier[] {
  const starred = new Set(opts.starredTags ?? [])
  const nowMs = Date.parse(nowIso)
  const today = dayOf(nowIso)
  const base = new Date(nowMs)
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const tomorrow = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`
  const suggestions: TaskSuggestion[] = tasks
    .filter((t) => SUGGEST_STATUSES.includes(t.status))
    .map((t) => {
      const ref = refTimeOf(t)
      const kindLabel = t.dueTime ? '截止' : '开始'
      let score = 0
      const reasons: string[] = []

      if (ref && Number.isFinite(Date.parse(ref))) {
        const refMs = Date.parse(ref)
        const hoursLeft = (refMs - nowMs) / HOUR_MS
        if (t.status === 'overdue' || ref < nowIso) {
          const daysLate = Math.max(0, Math.floor(-hoursLeft / 24))
          score += 100 + Math.min(daysLate, 7) * 3
          reasons.push(daysLate >= 1 ? `已过期 ${daysLate} 天` : t.status === 'overdue' ? '已延期' : '时间已过')
        } else if (hoursLeft <= 3) {
          score += 92
          reasons.push(`3 小时内${kindLabel}`)
        } else if (dayOf(ref) === today) {
          score += 80
          reasons.push(`今天${kindLabel}`)
        } else if (dayOf(ref) === tomorrow) {
          score += 62
          reasons.push(`明天${kindLabel}`)
        } else if (hoursLeft <= 72) {
          score += 48
          reasons.push('三天内')
        } else if (hoursLeft <= 168) {
          score += 32
          reasons.push('本周内')
        } else {
          score += 15
        }
        if (t.dueTime) score += 4 // 硬截止比软开始更值得先办
      } else {
        score += 24
        reasons.push('待安排时间')
      }

      if (t.priority === 'high') {
        score += 20
        reasons.push('高优先级')
      } else if (t.priority === 'medium') {
        score += 8
      } else if (t.priority === 'low') {
        score -= 6
      }
      if (t.status === 'in_progress') {
        score += 6
        reasons.push('进行中')
      }
      if (t.tags.some((tag) => starred.has(tag))) {
        score += 12
        reasons.push('重点标签')
      }
      return { task: t, score, reasons }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ta = refTimeOf(a.task)
      const tb = refTimeOf(b.task)
      if (ta && tb && ta !== tb) return ta.localeCompare(tb)
      if (!!ta !== !!tb) return ta ? -1 : 1
      return a.task.title.localeCompare(b.task.title)
    })

  const tiers: SuggestionTier[] = [
    { title: '马上处理', items: suggestions.filter((s) => s.score >= 88) },
    { title: '今天之内', items: suggestions.filter((s) => s.score >= 55 && s.score < 88) },
    { title: '稍后再看', items: suggestions.filter((s) => s.score < 55) }
  ]
  return tiers.filter((tier) => tier.items.length > 0)
}
