import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppCategory,
  AppCategoryOverride,
  AppSwitchRecord,
  AppUsageEntry,
  ReportRecord,
  WorkRecord
} from '@shared/types'
import { dayKey, focusDurations, formatDuration, timeRangeLabel } from '@shared/work-report'
import {
  ATTENTION_BASELINE_SEC,
  avgAttentionSpanSec,
  buildOverrideMap,
  categoryOf,
  deepBlockCount,
  deepWorkSeconds,
  focusScore,
  hourlySwitches,
  longestRunSeconds,
  productiveRunsFromSwitches,
  shortDwellShare,
  taskSwitchCount
} from '@shared/attention'
import { api } from '../api'
import { BarRow, DayNav, Section, Segmented } from '../components/ui'
import RecordHeat from '../components/RecordHeat'
import MiniCalendar from '../components/MiniCalendar'
import ReportModal from '../components/ReportModal'

const CATEGORY_META: Record<AppCategory, { label: string; cls: string }> = {
  productive: { label: '专注', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
  neutral: { label: '中性', cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  distracting: { label: '分心', cls: 'bg-amber-50 text-amber-600 border-amber-200' }
}
const NEXT_CATEGORY: Record<AppCategory, AppCategory> = {
  productive: 'neutral',
  neutral: 'distracting',
  distracting: 'productive'
}

function lastNDays(n: number): string[] {
  return Array.from({ length: n }, (_, i) => dayKey(new Date(Date.now() - (n - 1 - i) * 86_400_000)))
}

/**
 * 「分析」页：基于本地行为数据的注意力分析（指标口径见 shared/attention.ts 顶部注释）
 * + 历史日报回看。所有统计只用应用名与时刻，不涉及屏幕内容。
 */
export default function Analysis(): React.JSX.Element {
  const [day, setDay] = useState(() => dayKey(new Date()))
  const [records, setRecords] = useState<WorkRecord[]>([])
  const [usage, setUsage] = useState<AppUsageEntry[]>([])
  const [switches, setSwitches] = useState<AppSwitchRecord[]>([])
  const [overrides, setOverrides] = useState<AppCategoryOverride[]>([])
  const [trendSwitches, setTrendSwitches] = useState<AppSwitchRecord[]>([])
  const [trendUsage, setTrendUsage] = useState<(AppUsageEntry & { day: string })[]>([])
  const [usageYear, setUsageYear] = useState<(AppUsageEntry & { day: string })[]>([])
  // 页内双视角：当日（概览/碎片化/分类/任务专注）与回顾（热力/趋势/日报回看），
  // 拆成两个导航项会稀释侧边栏，Tab 即可（用户反馈板块过载后的取舍）
  const [view, setView] = useState<'day' | 'review'>('day')

  const loadDay = useCallback((d: string) => {
    void api.listWorkRecords(d).then(setRecords)
    void api.appUsageSummary(d).then(setUsage)
    // 保留全天之后的切换记录：深度工作段需要次日第一个切换作为当日最后一个区间的收尾边界
    void api.appSwitchesSince(d).then(setSwitches)
  }, [])

  useEffect(() => {
    loadDay(day)
  }, [day, loadDay])

  useEffect(() => {
    const weekAgo = lastNDays(7)[0]
    const today = dayKey(new Date())
    void api.appCategoryOverrides().then(setOverrides)
    void api.appSwitchesSince(weekAgo).then(setTrendSwitches)
    void api.appUsageRange(weekAgo, today).then(setTrendUsage)
    void api.appUsageRange(dayKey(new Date(Date.now() - 364 * 86_400_000)), today).then(setUsageYear)
  }, [])

  const cat = useMemo(() => {
    const map = buildOverrideMap(overrides)
    return (app: string): AppCategory => categoryOf(app, map)
  }, [overrides])

  // ---- 当日指标 ----
  // 专注段用前台应用切换口径（不依赖模型归类）；碎片化指标仍用当日切换子集
  const daySwitches = useMemo(() => switches.filter((s) => s.ts.startsWith(day)), [switches, day])
  const runs = useMemo(
    () => productiveRunsFromSwitches(switches, cat).filter((r) => r.start.startsWith(day)),
    [switches, cat, day]
  )
  const deepSec = deepWorkSeconds(runs)
  const score = focusScore(usage, cat)
  const activeSec = usage.reduce((n, u) => n + u.seconds, 0)
  const avgSpan = avgAttentionSpanSec(activeSec, daySwitches.length)
  const longest = longestRunSeconds(runs)
  const blocks = deepBlockCount(runs)
  const byHour = hourlySwitches(daySwitches)
  const shortShare = shortDwellShare(daySwitches)
  const busiestHour = byHour.some((n) => n > 0) ? byHour.indexOf(Math.max(...byHour)) : null

  // ---- 近 7 天趋势（固定为最近 7 天，不随 DayNav 变） ----
  const trendDays = lastNDays(7)
  const trend = trendDays.map((d) => {
    const dayRuns = productiveRunsFromSwitches(trendSwitches, cat).filter((r) => r.start.startsWith(d))
    const dayUsage = trendUsage.filter((u) => u.day === d)
    return {
      day: d,
      deep: deepWorkSeconds(dayRuns),
      score: focusScore(dayUsage, cat)
    }
  })
  const trendMax = Math.max(...trend.map((t) => t.deep), 1)

  // ---- 任务专注分布（当日，只读；校正入口在日报页） ----
  const taskFocus = focusDurations(records).slice(0, 6)
  const maxTask = Math.max(...taskFocus.map((t) => t.seconds), 1)

  const cycleCategory = async (app: string): Promise<void> => {
    await api.setAppCategory(app, NEXT_CATEGORY[cat(app)])
    void api.appCategoryOverrides().then(setOverrides)
  }
  const resetCategory = async (app: string): Promise<void> => {
    await api.setAppCategory(app, null)
    void api.appCategoryOverrides().then(setOverrides)
  }
  const overriddenApps = useMemo(() => new Set(overrides.map((o) => o.app)), [overrides])
  // 小日历的"有数据"圆点：近一年内有活跃时长的日子
  const activeDaySet = useMemo(
    () => new Set(usageYear.filter((u) => u.seconds > 0).map((u) => u.day)),
    [usageYear]
  )

  const heatClass = (n: number): string =>
    n === 0 ? 'bg-slate-100' : n <= 2 ? 'bg-brand/30' : n <= 5 ? 'bg-brand/60' : 'bg-brand'

  const stats: { label: string; value: string; hint?: string }[] = [
    {
      label: '深度工作',
      value: deepSec ? formatDuration(deepSec) : '—',
      hint: '≥15 分钟的连续专注段'
    },
    {
      label: '专注质量分',
      value: score === null ? '—' : String(score),
      hint: '分类时长加权 0-100'
    },
    {
      label: '平均专注时长',
      value: avgSpan === null ? '—' : formatDuration(avgSpan),
      hint: `大众基准约 ${ATTENTION_BASELINE_SEC} 秒`
    },
    // 刻意不放「应用切换 N 百次」：数字大且无行动指引，只制造焦虑（用户反馈）；
    // 任务级切换量级小、有语义，原始切换分布仍在下方碎片化区配着建议看
    { label: '任务切换', value: `${taskSwitchCount(records)} 次`, hint: '不同任务之间的跳转' },
    { label: '最长专注块', value: longest ? formatDuration(longest) : '—' },
    { label: '深度工作块', value: `${blocks} 个` }
  ]

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">分析</h1>
          <p className="mt-1 text-sm text-slate-400">
            {view === 'day'
              ? '从行为数据看今天的专注与碎片化。只统计应用名与时刻，不涉及屏幕内容。'
              : '历史节奏一览：时段热力、趋势与日报回看。'}
          </p>
        </div>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            ['day', '当日'],
            ['review', '回顾']
          ]}
        />
      </div>

      {/* 日期导航独立成行：与标题挤一行会换行错乱（用户反馈）；小日历可跳任意一天 */}
      {view === 'day' && (
        <div className="-mt-2 flex items-center justify-between">
          <DayNav day={day} onChange={setDay} />
          <MiniCalendar day={day} onChange={setDay} activeDays={activeDaySet} />
        </div>
      )}

      {view === 'day' && (
      <Section title="当日概览">
        <div className="grid grid-cols-3 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg bg-slate-50 px-4 py-3">
              <div className="text-lg font-semibold">{s.value}</div>
              <div className="mt-0.5 text-xs text-slate-400">{s.label}</div>
              {s.hint && <div className="mt-0.5 text-[10px] text-slate-300">{s.hint}</div>}
            </div>
          ))}
        </div>
        {activeSec === 0 && (
          <p className="mt-3 text-xs text-slate-400">
            这一天没有活跃数据。开启「设置 → 屏幕感知」后自动积累。
          </p>
        )}
      </Section>
      )}

      {view === 'review' && (
      <>
      <Section title="时段热力" desc="按周看每小时的记录分布，可前后翻周；切「年度」看全年活跃日历。">
        <RecordHeat />
      </Section>

      <Section title="近 7 天趋势" desc="柱高为深度工作时长，柱下数字为当日专注质量分。">
        <div className="flex items-end gap-2">
          {trend.map((t) => (
            <div key={t.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-[10px] text-slate-400">
                {t.deep ? formatDuration(t.deep) : ''}
              </span>
              <div className="flex h-24 w-full items-end rounded bg-slate-50">
                <div
                  className="w-full rounded bg-brand/70"
                  style={{ height: `${Math.round((t.deep / trendMax) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] font-medium text-slate-500">{t.score ?? '—'}</span>
              <span className="text-[10px] text-slate-400">{t.day.slice(5)}</span>
            </div>
          ))}
        </div>
      </Section>
      </>
      )}

      {view === 'day' && (
      <>
      <Section
        title="注意力碎片化"
        desc="每小时的应用切换次数。频繁切换的时段适合合并同类任务、批量处理消息。"
      >
        <div className="flex gap-1">
          {byHour.map((n, h) => (
            <div key={h} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className={`h-7 w-full rounded ${heatClass(n)}`} title={`${h}:00 · ${n} 次切换`} />
              {h % 6 === 0 && <span className="text-[10px] text-slate-400">{h}:00</span>}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 text-xs text-slate-400">
          {shortShare !== null && (
            <span>
              短停留占比 {Math.round(shortShare * 100)}%（切换后不足 2 分钟又切走，按次数的自定义口径）
            </span>
          )}
          {busiestHour !== null && <span>最碎时段 {busiestHour}:00–{busiestHour + 1}:00</span>}
          {switches.length === 0 && <span>暂无切换数据。</span>}
        </div>
      </Section>

      <Section
        title="应用分类"
        desc="专注质量分与深度工作依赖这里的分类。点击标签在 专注/中性/分心 间切换，校正默认规则。"
      >
        {usage.length === 0 ? (
          <p className="py-2 text-sm text-slate-400">暂无应用数据。</p>
        ) : (
          <ul className="flex flex-col">
            {usage.slice(0, 10).map((u) => (
              <li
                key={u.app}
                className="flex items-center gap-3 border-b border-slate-100 py-2 text-sm last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate">{u.app}</span>
                <span className="shrink-0 text-xs text-slate-400">{formatDuration(u.seconds)}</span>
                <button
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] ${CATEGORY_META[cat(u.app)].cls}`}
                  onClick={() => void cycleCategory(u.app)}
                >
                  {CATEGORY_META[cat(u.app)].label}
                </button>
                {overriddenApps.has(u.app) ? (
                  <button
                    className="shrink-0 px-1 text-[11px] text-slate-400 hover:text-slate-600"
                    onClick={() => void resetCategory(u.app)}
                  >
                    重置
                  </button>
                ) : (
                  <span className="shrink-0 px-1 text-[11px] text-slate-300">默认</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="任务专注分布" desc="当日按任务归并的专注时长（校正任务名在日报页）。">
        {taskFocus.length === 0 ? (
          <p className="py-2 text-sm text-slate-400">暂无任务归类。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {taskFocus.map((f) => (
              <BarRow
                key={f.task}
                label={f.task}
                value={f.seconds}
                max={maxTask}
                valueLabel={formatDuration(f.seconds)}
                detail={timeRangeLabel(f.startAt, f.endAt)}
              />
            ))}
          </ul>
        )}
      </Section>
      </>
      )}

      {view === 'review' && <ReportBrowser />}
    </div>
  )
}

/** 日报回看：从日报页迁入——快速按范围翻看/导出/删除历史日报（日报页只留当天）。 */
function ReportBrowser(): React.JSX.Element {
  const [reports, setReports] = useState<ReportRecord[]>([])
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('7d')
  const [openId, setOpenId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    void api.listReports().then(setReports)
  }, [])

  useEffect(() => {
    load()
    return api.on('guzi-assistant:reports-updated', load)
  }, [load])

  const cutoff =
    range === 'all' ? '' : dayKey(new Date(Date.now() - (range === '7d' ? 6 : 29) * 86_400_000))
  const shown = reports.filter((r) => r.day >= cutoff)

  const exportReport = async (r: ReportRecord): Promise<void> => {
    const ok = await api.exportReport({ title: r.title, content: r.content })
    if (ok) {
      setNote('已导出')
      window.setTimeout(() => setNote(''), 3000)
    }
  }
  const removeReport = async (id: string): Promise<void> => {
    await api.deleteReport(id)
    if (openId === id) setOpenId(null)
    load()
  }

  return (
    <Section
      title="日报回看"
      actions={
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            ['7d', '近 7 天'],
            ['30d', '近 30 天'],
            ['all', '全部']
          ]}
        />
      }
    >
      {shown.length === 0 ? (
        <p className="py-2 text-sm text-slate-400">这个范围内没有日报。到「日报」页生成。</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => (
            <li key={r.id} className="border-b border-slate-100 py-2 last:border-b-0">
              <div className="flex items-center gap-3">
                <button
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-brand"
                  onClick={() => setOpenId(r.id)}
                >
                  {r.title}
                </button>
                <span className="shrink-0 text-xs text-slate-400">
                  {r.createdAt.slice(5, 16).replace('T', ' ')}
                </span>
                <button
                  className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => void exportReport(r)}
                >
                  导出
                </button>
                <button
                  className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 hover:text-red-500"
                  onClick={() => void removeReport(r.id)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(() => {
        const open = shown.find((r) => r.id === openId)
        return open ? (
          <ReportModal report={open} onExport={() => void exportReport(open)} onClose={() => setOpenId(null)} />
        ) : null
      })()}
      {note && (
        <div className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm text-white shadow-lg">
          {note}
        </div>
      )}
    </Section>
  )
}
