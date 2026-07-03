import { useState } from 'react'
import type { AppUsageEntry, WorkRecord } from '@shared/types'
import { dayKey, formatDuration } from '@shared/work-report'
import { Segmented } from './ui'

/**
 * 时段热力（分析页）：周视图 = 近 7 天 × 24 小时的记录密度网格；
 * 年度视图 = 贡献日历（按天活跃时长）。历史节奏一眼可读（对标竞品热力图，配色走品牌）。
 */

interface Props {
  /** 近 7 天工作记录（周视图素材） */
  records7: WorkRecord[]
  /** 近一年应用时长（年度视图素材，day×app 粒度） */
  usageYear: (AppUsageEntry & { day: string })[]
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_MS = 86_400_000

export default function RecordHeat({ records7, usageYear }: Props): React.JSX.Element {
  const [mode, setMode] = useState<'week' | 'year'>('week')
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            ['week', '周'],
            ['year', '年度']
          ]}
        />
      </div>
      {mode === 'week' ? <WeekGrid records={records7} /> : <YearGrid usage={usageYear} />}
    </div>
  )
}

function weekCellCls(n: number): string {
  if (n === 0) return 'bg-slate-100'
  if (n <= 1) return 'bg-brand/25'
  if (n <= 3) return 'bg-brand/50'
  if (n <= 6) return 'bg-brand/75'
  return 'bg-brand'
}

function WeekGrid({ records }: { records: WorkRecord[] }): React.JSX.Element {
  // day → 24 小时计数
  const byDay = new Map<string, number[]>()
  for (const r of records) {
    const d = r.createdAt.slice(0, 10)
    const h = Number(r.createdAt.slice(11, 13))
    if (!byDay.has(d)) byDay.set(d, Array<number>(24).fill(0))
    if (h >= 0 && h < 24) byDay.get(d)![h]++
  }
  const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(Date.now() - (6 - i) * DAY_MS)))

  return (
    <div className="flex flex-col gap-1.5">
      {days.map((d, i) => {
        const counts = byDay.get(d) ?? Array<number>(24).fill(0)
        const total = counts.reduce((a, b) => a + b, 0)
        const label = i === 6 ? '今天' : i === 5 ? '昨天' : WEEKDAY[new Date(`${d}T12:00`).getDay()]
        return (
          <div key={d} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-right text-[11px] text-slate-400">{label}</span>
            <div className="flex min-w-0 flex-1 gap-[3px]">
              {counts.map((n, h) => (
                <div key={h} className={`h-4 min-w-0 flex-1 rounded-[3px] ${weekCellCls(n)}`} title={`${d} ${h}:00 · ${n} 条记录`} />
              ))}
            </div>
            <span className="w-12 shrink-0 text-[11px] text-slate-400">{total} 条</span>
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0" />
        <div className="flex min-w-0 flex-1 gap-[3px] text-[10px] text-slate-400">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="min-w-0 flex-1">
              {h % 6 === 0 ? `${h}` : ''}
            </span>
          ))}
        </div>
        <span className="w-12 shrink-0" />
      </div>
    </div>
  )
}

function yearCellCls(sec: number): string {
  if (sec === 0) return 'bg-slate-100'
  if (sec < 3600) return 'bg-brand/25'
  if (sec < 3 * 3600) return 'bg-brand/50'
  if (sec < 6 * 3600) return 'bg-brand/75'
  return 'bg-brand'
}

function YearGrid({ usage }: { usage: (AppUsageEntry & { day: string })[] }): React.JSX.Element {
  const secsByDay = new Map<string, number>()
  for (const u of usage) secsByDay.set(u.day, (secsByDay.get(u.day) ?? 0) + u.seconds)

  // 从 364 天前所在周的周一开始，铺满到今天
  const start = new Date(Date.now() - 364 * DAY_MS)
  while (start.getDay() !== 1) start.setDate(start.getDate() - 1)
  const today = dayKey(new Date())
  const weeks: { days: (string | null)[]; monthLabel: string }[] = []
  for (let w = new Date(start); dayKey(w) <= today; w.setDate(w.getDate() + 7)) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(w.getTime() + i * DAY_MS)
      const k = dayKey(d)
      return k <= today ? k : null
    })
    // 本周内出现每月 1 号 → 打月份标签
    const first = days.find((d) => d && d.endsWith('-01'))
    weeks.push({ days, monthLabel: first ? `${Number(first.slice(5, 7))}月` : '' })
  }

  const activeDays = [...secsByDay.values()].filter((s) => s > 0).length

  return (
    <div className="flex flex-col gap-1">
      {/* 9px 格 + 2px 缝：54 周 ≈ 592px，稳在 max-w-3xl 卡片内；外层再兜底横向滚动防裁切 */}
      <div className="overflow-x-auto pb-1">
        <div className="flex flex-col gap-1">
          <div className="flex gap-[2px]">
            {weeks.map((w, i) => (
              <span key={i} className="w-[9px] shrink-0 overflow-visible text-[9px] whitespace-nowrap text-slate-400">
                {w.monthLabel}
              </span>
            ))}
          </div>
          <div className="flex gap-[2px]">
            {weeks.map((w, i) => (
              <div key={i} className="flex shrink-0 flex-col gap-[2px]">
                {w.days.map((d, j) =>
                  d ? (
                    <div
                      key={j}
                      className={`size-[9px] rounded-[2px] ${yearCellCls(secsByDay.get(d) ?? 0)}`}
                      title={`${d} · 活跃 ${secsByDay.get(d) ? formatDuration(secsByDay.get(d)!) : '0 分钟'}`}
                    />
                  ) : (
                    <div key={j} className="size-[9px]" />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>{activeDays < 14 ? `已积累 ${activeDays} 个活跃日，日历会随使用慢慢点亮` : `全年活跃 ${activeDays} 天`}</span>
        <span className="flex items-center gap-1">
          少
          <span className="size-[9px] rounded-[2px] bg-slate-100" />
          <span className="size-[9px] rounded-[2px] bg-brand/25" />
          <span className="size-[9px] rounded-[2px] bg-brand/50" />
          <span className="size-[9px] rounded-[2px] bg-brand/75" />
          <span className="size-[9px] rounded-[2px] bg-brand" />
          多
        </span>
      </div>
    </div>
  )
}
