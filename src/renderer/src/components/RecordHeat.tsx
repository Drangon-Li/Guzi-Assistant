import { useEffect, useState } from 'react'
import type { WorkRecord } from '@shared/types'
import { dayKey, formatDuration } from '@shared/work-report'
import { api } from '../api'
import { Segmented } from './ui'

/**
 * 时段热力（分析页·回顾）：周视图 = 任意一周 × 24 小时的记录密度网格（可前后翻周）；
 * 年度视图 = 按自然年的贡献日历（可切年份）。自取数：翻到哪段拉哪段。
 */

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_MS = 86_400_000

export default function RecordHeat(): React.JSX.Element {
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
      {mode === 'week' ? <WeekGrid /> : <YearGrid />}
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

function WeekGrid(): React.JSX.Element {
  // offset=0：以今天为末日的 7 天；每 +1 往前推一周
  const [offset, setOffset] = useState(0)
  const [records, setRecords] = useState<WorkRecord[]>([])

  const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(Date.now() - (offset * 7 + 6 - i) * DAY_MS)))

  useEffect(() => {
    void api.workRecordsSince(days[0]).then((rs) => setRecords(rs.filter((r) => r.startAt.slice(0, 10) <= days[6])))
    // days 由 offset 派生，依赖 offset 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset])

  const byDay = new Map<string, number[]>()
  for (const r of records) {
    const d = r.startAt.slice(0, 10)
    const h = Number(r.startAt.slice(11, 13))
    if (!byDay.has(d)) byDay.set(d, Array<number>(24).fill(0))
    if (h >= 0 && h < 24) byDay.get(d)![h]++
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="mb-1 flex items-center justify-between">
        <button className="rounded-md px-2 py-0.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => setOffset(offset + 1)}>
          ‹
        </button>
        <span className="text-xs text-slate-500">
          {days[0].slice(5).replace('-', '/')} ~ {days[6].slice(5).replace('-', '/')}
          {offset > 0 && (
            <button className="ml-2 text-brand hover:underline" onClick={() => setOffset(0)}>
              回本周
            </button>
          )}
        </span>
        <button
          className="rounded-md px-2 py-0.5 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-30"
          disabled={offset === 0}
          onClick={() => setOffset(offset - 1)}
        >
          ›
        </button>
      </div>
      {days.map((d, i) => {
        const counts = byDay.get(d) ?? Array<number>(24).fill(0)
        const total = counts.reduce((a, b) => a + b, 0)
        const label =
          offset === 0 && i === 6 ? '今天' : offset === 0 && i === 5 ? '昨天' : WEEKDAY[new Date(`${d}T12:00`).getDay()]
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

function YearGrid(): React.JSX.Element {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const [secsByDay, setSecsByDay] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    void api.appUsageRange(`${year}-01-01`, `${year}-12-31`).then((rows) => {
      const m = new Map<string, number>()
      for (const u of rows) m.set(u.day, (m.get(u.day) ?? 0) + u.seconds)
      setSecsByDay(m)
    })
  }, [year])

  const today = dayKey(new Date())
  // 从 1 月 1 日所在周的周一铺到 12 月 31 日
  const start = new Date(year, 0, 1)
  while (start.getDay() !== 1) start.setDate(start.getDate() - 1)
  const yearEnd = `${year}-12-31`
  const weeks: { days: (string | null)[]; monthLabel: string }[] = []
  for (let w = new Date(start); dayKey(w) <= yearEnd; w.setDate(w.getDate() + 7)) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const k = dayKey(new Date(w.getTime() + i * DAY_MS))
      return k.startsWith(String(year)) && k <= today ? k : null
    })
    const first = days.find((d) => d && d.endsWith('-01'))
    weeks.push({ days, monthLabel: first ? `${Number(first.slice(5, 7))}月` : '' })
  }

  const activeDays = [...secsByDay.values()].filter((s) => s > 0).length

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-1 flex items-center justify-between">
        <button className="rounded-md px-2 py-0.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => setYear(year - 1)}>
          ‹
        </button>
        <span className="text-xs text-slate-500">{year} 年</span>
        <button
          className="rounded-md px-2 py-0.5 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-30"
          disabled={year === thisYear}
          onClick={() => setYear(year + 1)}
        >
          ›
        </button>
      </div>
      {/* 9px 格 + 2px 缝：53 周 ≈ 581px，稳在卡片内；外层再兜底横向滚动防裁切 */}
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
        <span>{activeDays < 14 ? `已积累 ${activeDays} 个活跃日，日历会随使用慢慢点亮` : `${year} 年活跃 ${activeDays} 天`}</span>
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
