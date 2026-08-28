// 专注统计：周 / 月 / 年三档，看总量、趋势、时段分布和时间去向。
import { useCallback, useEffect, useState } from 'react'
import {
  focusLabel,
  type RangeStats,
  type StatsRange,
  type TaskBreakdown
} from '@shared/pomodoro'
import { api } from '../../api'
import { Section, Segmented } from '../../components/ui'

interface StatsPayload {
  range: StatsRange
  fromDate: string
  toDate: string
  stats: RangeStats
  byTask: TaskBreakdown[]
  byHour: number[]
  byWeekday: number[]
  daily: { date: string; rounds: number; focusMinutes: number; hitGoal: boolean }[]
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const RANGE_LABEL: Record<StatsRange, string> = { week: '最近 7 天', month: '最近 30 天', year: '最近一年' }

export default function PomodoroStats(): React.JSX.Element {
  const [range, setRange] = useState<StatsRange>('month')
  const [data, setData] = useState<StatsPayload | null>(null)

  const load = useCallback(async (r: StatsRange) => {
    setData(await api.plugin<StatsPayload>('pomodoro', 'stats', r))
  }, [])

  useEffect(() => {
    void load(range)
  }, [load, range])

  if (!data) return <p className="py-10 text-center text-sm text-slate-400">统计加载中…</p>

  const s = data.stats
  const noData = s.rounds === 0
  // 一年 365 根柱子挤不下，按周聚合
  const series =
    range === 'year' ? aggregateWeekly(data.daily) : data.daily.map((d) => ({ key: d.date, ...d }))
  const maxMinutes = Math.max(1, ...series.map((d) => d.focusMinutes))
  const maxHour = Math.max(1, ...data.byHour)
  const maxWeekday = Math.max(1, ...data.byWeekday)
  const peakHour = data.byHour.indexOf(Math.max(...data.byHour))

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <Segmented
          value={range}
          options={[
            ['week', '周'],
            ['month', '月'],
            ['year', '年']
          ]}
          onChange={setRange}
        />
        <span className="text-xs text-slate-400 tabular-nums">
          {data.fromDate} — {data.toDate}
        </span>
      </div>

      {noData ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-5 py-10 text-center text-sm text-slate-400">
          {RANGE_LABEL[range]}还没有完成过专注。
        </p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="总专注" value={focusLabel(s.focusMinutes)} />
            <Stat label="完成轮数" value={`${s.rounds} 轮`} />
            <Stat label="有专注的天数" value={`${s.activeDays} 天`} />
            <Stat label="达标天数" value={`${s.goalDays} 天`} />
            <Stat label="活跃日均" value={focusLabel(s.avgMinutesPerActiveDay)} />
            <Stat label="完成率" value={`${Math.round(s.completionRate * 100)}%`} />
            <Stat label="最长连续达标" value={`${s.bestGoalStreak} 天`} />
            <Stat
              label="最投入的一天"
              value={s.bestDay ? `${s.bestDay.date.slice(5)} · ${focusLabel(s.bestDay.minutes)}` : '—'}
            />
          </div>

          <Section
            title="趋势"
            desc={range === 'year' ? '按周汇总的专注时长' : '每天的专注时长，达标那天是实心的'}
          >
            <div className="flex h-28 items-end gap-[3px] overflow-x-auto">
              {series.map((d) => (
                <div key={d.key} className="flex min-w-[6px] flex-1 flex-col items-center gap-1">
                  <div
                    title={`${d.key}：${focusLabel(d.focusMinutes)} · ${d.rounds} 轮`}
                    className={`w-full rounded-t ${
                      d.focusMinutes === 0 ? 'bg-slate-100' : d.hitGoal ? 'bg-brand' : 'bg-brand/40'
                    }`}
                    style={{ height: `${Math.max(3, (d.focusMinutes / maxMinutes) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
          </Section>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section
              title="几点最专注"
              desc={data.byHour[peakHour] > 0 ? `你的高产时段是 ${peakHour}:00 前后` : '还看不出规律'}
            >
              <div className="flex h-20 items-end gap-[2px]">
                {data.byHour.map((m, h) => (
                  <div
                    key={h}
                    title={`${String(h).padStart(2, '0')}:00 · ${focusLabel(m)}`}
                    className={`flex-1 rounded-t ${
                      m === 0 ? 'bg-slate-100' : h === peakHour ? 'bg-brand' : 'bg-brand/40'
                    }`}
                    style={{ height: `${Math.max(3, (m / maxHour) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-slate-300 tabular-nums">
                <span>0</span>
                <span>6</span>
                <span>12</span>
                <span>18</span>
                <span>24</span>
              </div>
            </Section>

            <Section title="哪天最专注" desc="按星期汇总">
              <div className="flex h-20 items-end gap-1.5">
                {data.byWeekday.map((m, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      title={`周${WEEKDAY_LABELS[i]} · ${focusLabel(m)}`}
                      className={`w-full rounded-t ${m === 0 ? 'bg-slate-100' : 'bg-brand/60'}`}
                      style={{ height: `${Math.max(3, (m / maxWeekday) * 100)}%` }}
                    />
                    <span className="text-[10px] text-slate-300">{WEEKDAY_LABELS[i]}</span>
                  </div>
                ))}
              </div>
            </Section>
          </div>

          {data.byTask.length > 0 && (
            <div className="mt-4">
              <Section title="时间去哪了" desc={`${RANGE_LABEL[range]}完成的专注按关联任务归集`}>
                <ul className="space-y-2">
                  {data.byTask.map((row) => {
                    const max = data.byTask[0].minutes || 1
                    return (
                      <li key={row.key} className="flex items-center gap-3 text-sm">
                        <span className="w-40 shrink-0 truncate" title={row.label}>
                          {row.label}
                        </span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <span
                            className="block h-full rounded-full bg-brand/60"
                            style={{ width: `${Math.round((row.minutes / max) * 100)}%` }}
                          />
                        </span>
                        <span className="w-28 shrink-0 text-right text-xs text-slate-400 tabular-nums">
                          {focusLabel(row.minutes)} · {row.rounds} 轮
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 一年 365 根柱子挤不下，按自然周聚合成 52 根。 */
function aggregateWeekly(
  daily: { date: string; rounds: number; focusMinutes: number; hitGoal: boolean }[]
): { key: string; rounds: number; focusMinutes: number; hitGoal: boolean }[] {
  const out: { key: string; rounds: number; focusMinutes: number; hitGoal: boolean }[] = []
  for (let i = 0; i < daily.length; i += 7) {
    const chunk = daily.slice(i, i + 7)
    out.push({
      key: `${chunk[0].date} 起`,
      rounds: chunk.reduce((n, d) => n + d.rounds, 0),
      focusMinutes: chunk.reduce((n, d) => n + d.focusMinutes, 0),
      // 一周里有过达标日就算这根柱子达标
      hitGoal: chunk.some((d) => d.hitGoal)
    })
  }
  return out
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-sm">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums">{value}</div>
    </div>
  )
}
