// 一轮专注结束后的复盘：先在本地算出客观指标，再交给模型写成人话。
//
// 分工是刻意的——「切了 17 次应用」「短停留占 62%」这类事实由代码算，模型只负责组织语言
// 和给一条建议。让模型自己从原始事件里数数会数错，而数错的复盘比没有复盘更糟。
//
// 复盘不自动入库：生成后交给用户决定保留还是丢弃。这一轮可能只是去查了个资料，
// 用户不想让它留在记录里，就该能直接扔掉。
import type { AppSwitchRecord, WorkRecord } from './types'
// 运行时导入要带扩展名（Node 直跑 .ts 时的 ESM 解析要求），与 main/ 下的写法一致
import { avgAttentionSpanSec, shortDwellShare } from './attention.ts'

export interface RoundEvidence {
  /** 计划时长（分钟） */
  minutes: number
  /** 实际投入（分钟，扣掉暂停） */
  actualMinutes: number
  /** 这一轮关联的任务 */
  taskTitle: string | null
  /** 窗口内的前台应用切换次数 */
  switchCount: number
  /** 平均专注时长（秒）；数据不足为 null */
  avgSpanSec: number | null
  /** 短停留占比 0..1；切换少于两次为 null */
  shortDwell: number | null
  /** 窗口内停留过的应用，按出现次数降序 */
  apps: { app: string; count: number }[]
  /** 窗口内屏幕感知给出的工作记录摘要 */
  activities: string[]
  /** 暂停次数（由累计暂停时长是否非零推断，只区分有没有） */
  paused: boolean
}

const ms = (iso: string): number => new Date(iso).getTime()

/** 落在 [from, to] 里的切换事件。 */
export function switchesInWindow(
  switches: readonly AppSwitchRecord[],
  from: string,
  to: string
): AppSwitchRecord[] {
  const a = ms(from)
  const b = ms(to)
  if (Number.isNaN(a) || Number.isNaN(b)) return []
  return switches.filter((s) => {
    const t = ms(s.ts)
    return !Number.isNaN(t) && t >= a && t <= b
  })
}

/** 与 [from, to] 有交集的工作记录。 */
export function recordsInWindow(
  records: readonly WorkRecord[],
  from: string,
  to: string
): WorkRecord[] {
  const a = ms(from)
  const b = ms(to)
  if (Number.isNaN(a) || Number.isNaN(b)) return []
  return records.filter((r) => {
    const s = ms(r.startAt)
    const e = ms(r.endAt)
    return !Number.isNaN(s) && !Number.isNaN(e) && e > a && s < b
  })
}

export function buildRoundEvidence(input: {
  from: string
  to: string
  minutes: number
  actualMinutes: number
  taskTitle: string | null
  paused: boolean
  switches: readonly AppSwitchRecord[]
  records: readonly WorkRecord[]
}): RoundEvidence {
  const inWindow = switchesInWindow(input.switches, input.from, input.to)
  const counts = new Map<string, number>()
  for (const s of inWindow) counts.set(s.toApp, (counts.get(s.toApp) ?? 0) + 1)

  const activities = [
    ...new Set(
      recordsInWindow(input.records, input.from, input.to)
        .map((r) => (r.task ? `${r.task}：${r.content}` : r.content))
        .map((t) => t.trim())
        .filter(Boolean)
    )
  ].slice(0, 8)

  return {
    minutes: input.minutes,
    actualMinutes: input.actualMinutes,
    taskTitle: input.taskTitle,
    paused: input.paused,
    switchCount: inWindow.length,
    avgSpanSec: avgAttentionSpanSec(input.actualMinutes * 60, inWindow.length),
    shortDwell: shortDwellShare(inWindow),
    apps: [...counts.entries()]
      .map(([app, count]) => ({ app, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    activities
  }
}

/**
 * 证据够不够写一份复盘。屏幕感知没开时切换事件和工作记录都是空的，
 * 这时候硬让模型写只会得到一段编造的空话——直接不生成，比生成废话诚实。
 */
export function hasEnoughEvidence(e: RoundEvidence): boolean {
  return e.switchCount >= 3 || e.activities.length > 0
}

/** 打断程度的本地判定，供提示词和界面共用，不让模型自由发挥。 */
export function interruptionLevel(e: RoundEvidence): 'low' | 'medium' | 'high' {
  const perHour = e.actualMinutes > 0 ? (e.switchCount / e.actualMinutes) * 60 : 0
  const fragmented = (e.shortDwell ?? 0) >= 0.5
  if (perHour >= 30 || (perHour >= 20 && fragmented)) return 'high'
  if (perHour >= 10 || fragmented) return 'medium'
  return 'low'
}

export const INTERRUPTION_LABEL: Record<'low' | 'medium' | 'high', string> = {
  low: '基本没被打断',
  medium: '偶有切换',
  high: '打断比较多'
}

function pct(v: number | null): string {
  return v === null ? '数据不足' : `${Math.round(v * 100)}%`
}

/** 复盘提示词。事实全部由本地算好写进去，模型不负责数数。 */
export function buildRoundReviewPrompt(
  userName: string,
  e: RoundEvidence
): { instructions: string; text: string } {
  const level = interruptionLevel(e)
  const instructions = `你是 谷子助手，${userName} 的个人助手。刚刚结束一轮专注，你要写一段很短的复盘。

# 要求
- 三到四句话，纯中文，不要 markdown 标题、列表或代码块，直接写成一小段。
- 第一句说这段时间主要在做什么（依据下面的活动记录和应用；记录为空就说"没采到活动记录"，**不要编**）。
- 第二句说注意力状态，必须与给出的判定一致：${INTERRUPTION_LABEL[level]}。
- 最后给一条具体的小建议，针对这一轮的实际情况，不要说"保持专注"这类空话。
- 语气平实、不评判。这一轮没做好也不要指责，用户只是想看清自己。
- 所有数字直接引用下面给出的，不要自己重新计算或推断。`

  const lines = [
    `计划 ${e.minutes} 分钟，实际投入 ${e.actualMinutes} 分钟${e.paused ? '（中途暂停过）' : ''}`,
    e.taskTitle ? `关联任务：${e.taskTitle}` : '未关联任务',
    `前台应用切换 ${e.switchCount} 次`,
    e.avgSpanSec !== null ? `平均每次停留 ${Math.round(e.avgSpanSec / 60)} 分钟` : '停留时长数据不足',
    `短停留（不到 2 分钟就切走）占比 ${pct(e.shortDwell)}`,
    `打断判定：${INTERRUPTION_LABEL[level]}`,
    e.apps.length ? `停留过的应用：${e.apps.map((a) => `${a.app}(${a.count} 次)`).join('、')}` : '没有应用切换记录',
    e.activities.length ? `屏幕感知记到的活动：\n${e.activities.map((a) => `- ${a}`).join('\n')}` : '没有活动记录'
  ]
  return { instructions, text: lines.join('\n') }
}
