import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUsageEntry, ReportRecord, WorkRecord } from '@shared/types'
import {
  DAY_SEGMENTS,
  dayKey,
  daySegmentOf,
  focusDurations,
  formatDuration,
  groupWorkPeriods,
  normalizeTaskKey,
  periodLabel,
  timeRangeLabel
} from '@shared/work-report'
import { api } from '../api'
import { BarRow, DayNav, Section, Segmented } from '../components/ui'
import ReportModal from '../components/ReportModal'
import ActivityDetail, { ActivityRangeNav } from '../components/ActivityDetail'
import type { HistoryRangePreset } from '@shared/history'

type ReportView = 'work' | 'activity'

/** 「日报」页：当日工作记录时间线 + 应用/任务时长 + 生成/回看工作日报；
 *  「活动明细」是并进来的原「历史」页，看的是同一条屏幕感知数据流的更细粒度。 */
export default function Reports(): React.JSX.Element {
  const [view, setView] = useState<ReportView>('work')
  const [day, setDay] = useState(() => dayKey(new Date()))
  // 活动明细的范围档位放在这里：它的翻页器和工作记录的 DayNav 共用页头同一个位置
  const [preset, setPreset] = useState<HistoryRangePreset>('all')
  const [records, setRecords] = useState<WorkRecord[]>([])
  const [usage, setUsage] = useState<AppUsageEntry[]>([])
  const [reports, setReports] = useState<ReportRecord[]>([])
  const [openReportId, setOpenReportId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [taskPrefs, setTaskPrefs] = useState<{ name: string; hidden: boolean; custom: boolean }[]>([])
  const [newTask, setNewTask] = useState('')
  const recordListRef = useRef<HTMLDivElement | null>(null)

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 3000)
  }

  const loadDay = useCallback((d: string) => {
    void api.listWorkRecords(d).then(setRecords)
    void api.appUsageSummary(d).then(setUsage)
    void api.focusTaskPrefs().then(setTaskPrefs)
  }, [])

  const loadReports = useCallback(() => {
    void api.listReports().then(setReports)
  }, [])

  useEffect(() => {
    loadDay(day)
  }, [day, loadDay])

  useEffect(() => {
    loadReports()
    return api.on('guzi-assistant:reports-updated', loadReports)
  }, [loadReports])

  const generate = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.generateReport(day)
      setOpenReportId(r.id)
      flash(`已生成「${r.title}」`)
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removePeriod = async (ids: string[]): Promise<void> => {
    await Promise.all(ids.map((id) => api.deleteWorkRecord(id)))
    loadDay(day)
  }

  const exportReport = async (r: ReportRecord): Promise<void> => {
    const ok = await api.exportReport({ title: r.title, content: r.content })
    if (ok) flash('已导出')
  }

  const removeReport = async (id: string): Promise<void> => {
    await api.deleteReport(id)
    if (openReportId === id) setOpenReportId(null)
    loadReports()
  }

  // 倒序展示：最新的时段在最上面（工作记录是「看最近干了什么」的场景）
  const periodsDesc = [...groupWorkPeriods(records)].reverse()
  // 时段分区锚点（清晨/上午/中午/下午/晚间/深夜），只显示有记录的分区
  const segmentsWithRecords = new Set(periodsDesc.map((p) => daySegmentOf(p.start).key))
  const segments = DAY_SEGMENTS.filter((s) => segmentsWithRecords.has(s.key))
  // 只滚内部列表容器：scrollIntoView 会连页面等所有可滚祖先一起滚，必须手动算容器内偏移
  const jumpToSegment = (key: string): void => {
    const list = recordListRef.current
    const el = list?.querySelector<HTMLElement>(`[data-seg="${key}"]`)
    if (!list || !el) return
    list.scrollTo({ top: el.offsetTop, behavior: 'smooth' })
  }

  // 当日报告：只显示所选日期的（历史回看在分析页）
  const dayReports = reports.filter((r) => r.day === day)

  // 任务专注：本地聚合 + 用户偏好（隐藏剔除、自定义补零显示）
  // 隐藏匹配命中归并组内任一写法——展示名可能随数据变化取到不同变体，只比展示串会漏隐藏
  const hidden = new Set(taskPrefs.filter((p) => p.hidden).map((p) => normalizeTaskKey(p.name)))
  const durations = focusDurations(records).filter((d) => !d.taskKeys.some((k) => hidden.has(k)))
  const shownKeys = new Set(durations.flatMap((d) => d.taskKeys))
  const focusList = [
    ...durations,
    ...taskPrefs
      .filter((p) => p.custom && !p.hidden && !shownKeys.has(normalizeTaskKey(p.name)))
      .map((p) => ({ task: p.name, seconds: 0, startAt: null, endAt: null, taskKeys: [normalizeTaskKey(p.name)] }))
  ]
  const maxFocus = Math.max(...focusList.map((f) => f.seconds), 1)
  const maxUsage = usage.length ? usage[0].seconds : 1

  const addTask = async (): Promise<void> => {
    const n = newTask.trim()
    if (!n) return
    await api.addFocusTask(n)
    setNewTask('')
    void api.focusTaskPrefs().then(setTaskPrefs)
  }
  const hideTask = async (name: string): Promise<void> => {
    await api.hideFocusTask(name)
    void api.focusTaskPrefs().then(setTaskPrefs)
  }

  // 标题与控件同一行、说明文字独占下一行：说明文字较长，三者挤一行会把
  // Segmented 压到断字换行（截图反馈的「工作记 录」）。
  const header = (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">日报</h1>
        <div className="flex shrink-0 items-center gap-3">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              ['work', '工作记录'],
              ['activity', '活动明细']
            ]}
          />
          {/* 两个视图的页头右侧都有翻页器，只是翻的东西不同：工作记录翻天，
              活动明细翻范围档位（它是 48 小时滚动窗口，按天翻没有意义） */}
          {view === 'work' ? (
            <DayNav day={day} onChange={setDay} />
          ) : (
            <ActivityRangeNav preset={preset} onChange={setPreset} />
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-slate-400">
        {view === 'work'
          ? '屏幕感知运行时自动记录「在做什么」，一键生成当日工作日报'
          : '屏幕感知最近 48 小时的细粒度活动；采集开关与清理在设置 → 屏幕感知'}
      </p>
    </div>
  )

  if (view === 'activity')
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
        {header}
        <div key="activity" className="animate-page flex flex-col gap-6">
          <ActivityDetail preset={preset} />
        </div>
      </div>
    )

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
      {header}

      <div key="work" className="animate-page flex flex-col gap-6">
        <Section
          title="工作记录"
          actions={
            <button
              className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-50"
              onClick={() => void generate()}
              disabled={busy}
            >
              {busy ? '正在生成…' : '生成当日日报'}
            </button>
          }
        >
          {records.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">
              这一天还没有工作记录。开启「设置 → 屏幕感知 → 工作记录」后，识别屏幕时会自动记下在做什么。
            </p>
          ) : (
            <>
              {segments.length > 1 && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {segments.map((s) => (
                    <button
                      key={s.key}
                      className="rounded-md bg-slate-100 px-2.5 py-0.5 text-[11px] text-slate-500 hover:bg-brand-soft hover:text-brand"
                      onClick={() => jumpToSegment(s.key)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              <div ref={recordListRef} className="relative max-h-72 overflow-y-auto">
                <ul className="flex flex-col">
                  {periodsDesc.map((p) => (
                    <li
                      key={p.start + p.summary}
                      data-seg={daySegmentOf(p.start).key}
                      className="group flex items-baseline gap-3 border-b border-slate-100 py-2 text-sm last:border-b-0"
                    >
                      <span className="w-24 shrink-0 font-mono text-xs text-slate-400">{periodLabel(p)}</span>
                      {p.app && (
                        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                          {p.app}
                        </span>
                      )}
                      <span className="shrink-0 rounded bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-400">
                        {p.source === 'accessibility' ? 'AX 语义' : 'OCR 补证'}
                      </span>
                      <span className="min-w-0 flex-1 leading-5">
                        {p.summary}
                        {p.activities.length > 1 && (
                          <span className="ml-1.5 text-xs text-slate-400">等 {p.activities.length} 项</span>
                        )}
                      </span>
                      <button
                        className="shrink-0 px-1 text-xs text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
                        onClick={() => void removePeriod(p.ids)}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </Section>

        <Section title="应用使用时长">
          {usage.length === 0 ? (
            <p className="py-2 text-sm text-slate-400">暂无数据（持续监控开启时按前台应用自动累计）。</p>
          ) : (
            // 默认露出 top-5（第 6 行露一条缝提示可滚），其余滚动看——与工作记录一致的内滚模式
            <div className="max-h-[148px] overflow-y-auto">
              <ul className="flex flex-col gap-2">
                {usage.map((u) => (
                  <BarRow key={u.app} label={u.app} value={u.seconds} max={maxUsage} valueLabel={formatDuration(u.seconds)} />
                ))}
              </ul>
            </div>
          )}
        </Section>

        <Section title="任务专注" desc="按任务归并的专注时长（模型自动归类）。删除或添加任务名可校正模型的归类。">
          {focusList.length === 0 ? (
            <p className="py-2 text-sm text-slate-400">暂无任务归类，积累一些工作记录后自动出现。</p>
          ) : (
            <div className="max-h-[148px] overflow-y-auto">
              <ul className="flex flex-col gap-2">
                {focusList.map((f) => (
                  <BarRow
                    key={f.task}
                    label={f.task}
                    value={f.seconds}
                    max={maxFocus}
                    valueLabel={f.seconds ? formatDuration(f.seconds) : '—'}
                    detail={timeRangeLabel(f.startAt, f.endAt)}
                    onDelete={() => void hideTask(f.task)}
                  />
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
              placeholder="添加任务名（模型会优先把活动归到已知任务）"
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addTask()
              }}
            />
            <button
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              onClick={() => void addTask()}
            >
              添加
            </button>
          </div>
        </Section>

        {/* 只看当天：历史范围回看已移至「分析 → 日报回看」 */}
        <Section title="当日报告">
          {dayReports.length === 0 ? (
            <p className="py-2 text-sm text-slate-400">
              这一天还没有日报。历史日报在「分析」页可按范围回看。
            </p>
          ) : (
            <ul className="flex flex-col">
              {dayReports.map((r) => (
                <li key={r.id} className="border-b border-slate-100 py-2 last:border-b-0">
                  <div className="flex items-center gap-3">
                    <button
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-brand"
                      onClick={() => setOpenReportId(r.id)}
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
        </Section>
      </div>

      {(() => {
        const open = reports.find((r) => r.id === openReportId)
        return open ? (
          <ReportModal report={open} onExport={() => void exportReport(open)} onClose={() => setOpenReportId(null)} />
        ) : null
      })()}

      {note && (
        <div className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm text-white shadow-lg">
          {note}
        </div>
      )}
    </div>
  )
}
