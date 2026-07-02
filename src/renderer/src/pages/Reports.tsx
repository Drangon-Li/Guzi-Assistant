import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUsageEntry, ReportRecord, WorkRecord } from '@shared/types'
import { dayKey, focusDurations, formatDuration, groupWorkPeriods, periodLabel } from '@shared/work-report'
import { api } from '../api'

/** 「日报」页：当日工作记录时间线 + 应用使用时长 + 生成/回看工作日报。 */
export default function Reports(): React.JSX.Element {
  const [day, setDay] = useState(() => dayKey(new Date()))
  const [records, setRecords] = useState<WorkRecord[]>([])
  const [usage, setUsage] = useState<AppUsageEntry[]>([])
  const [reports, setReports] = useState<ReportRecord[]>([])
  const [openReportId, setOpenReportId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [taskPrefs, setTaskPrefs] = useState<{ name: string; hidden: boolean; custom: boolean }[]>([])
  const [newTask, setNewTask] = useState('')
  const recordListRef = useRef<HTMLDivElement | null>(null)

  const today = dayKey(new Date())

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
    return api.on('eshell:reports-updated', loadReports)
  }, [loadReports])

  const shiftDay = (delta: number): void => {
    const d = new Date(`${day}T12:00`)
    d.setDate(d.getDate() + delta)
    const next = dayKey(d)
    if (next <= today) setDay(next)
  }

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

  const maxUsage = usage.length ? usage[0].seconds : 0

  const periods = groupWorkPeriods(records)
  // 时段锚点：有记录的小时（供长列表快速跳转）
  const hoursWithRecords = [...new Set(periods.map((p) => p.start.slice(11, 13)))]
  const jumpToHour = (hh: string): void => {
    recordListRef.current
      ?.querySelector(`[data-hour="${hh}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 任务专注：本地聚合 + 用户偏好（隐藏剔除、自定义补零显示）
  const hidden = new Set(taskPrefs.filter((p) => p.hidden).map((p) => p.name))
  const durations = focusDurations(records).filter((d) => !hidden.has(d.task))
  const shown = new Set(durations.map((d) => d.task))
  const customZero = taskPrefs
    .filter((p) => p.custom && !p.hidden && !shown.has(p.name))
    .map((p) => ({ task: p.name, seconds: 0 }))
  const focusList = [...durations, ...customZero]
  const maxFocus = focusList.length ? Math.max(...focusList.map((f) => f.seconds), 1) : 1

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

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">日报</h1>
          <p className="mt-1 text-sm text-slate-400">
            屏幕感知运行时自动记录「在做什么」，一键生成当日工作日报
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-500 hover:bg-slate-50"
            onClick={() => shiftDay(-1)}
          >
            ←
          </button>
          <span className="w-28 text-center font-medium">{day === today ? `今天 ${day.slice(5)}` : day}</span>
          <button
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
            onClick={() => shiftDay(1)}
            disabled={day >= today}
          >
            →
          </button>
        </div>
      </div>

      <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">工作记录</h2>
          <button
            className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-50"
            onClick={() => void generate()}
            disabled={busy}
          >
            {busy ? '正在生成…' : '生成当日日报'}
          </button>
        </div>
        {records.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">
            这一天还没有工作记录。开启「设置 → 屏幕感知 → 工作记录」后，识别屏幕时会自动记下在做什么。
          </p>
        ) : (
          <>
            {hoursWithRecords.length > 1 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {hoursWithRecords.map((hh) => (
                  <button
                    key={hh}
                    className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500 hover:bg-brand-soft hover:text-brand"
                    onClick={() => jumpToHour(hh)}
                  >
                    {hh}:00
                  </button>
                ))}
              </div>
            )}
            <div ref={recordListRef} className="max-h-72 overflow-y-auto">
              <ul className="flex flex-col">
                {periods.map((p) => (
                  <li
                    key={p.start + p.summary}
                    data-hour={p.start.slice(11, 13)}
                    className="group flex items-baseline gap-3 border-b border-slate-100 py-2 text-sm last:border-b-0"
                  >
                    <span className="w-24 shrink-0 font-mono text-xs text-slate-400">{periodLabel(p)}</span>
                    {p.app && (
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                        {p.app}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 leading-5">
                      {p.summary}
                      {p.activities.length > 1 && (
                        <span className="ml-1.5 text-xs text-slate-400">等 {p.activities.length} 项</span>
                      )}
                    </span>
                    <button
                      className="invisible shrink-0 px-1 text-xs text-slate-400 group-hover:visible hover:text-red-500"
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
      </section>

      <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">应用使用时长</h2>
        {usage.length === 0 ? (
          <p className="py-2 text-sm text-slate-400">暂无数据（持续监控开启时按前台应用自动累计）。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {usage.slice(0, 8).map((u) => (
              <li key={u.app} className="flex items-center gap-3 text-sm">
                <span className="w-36 shrink-0 truncate text-slate-600">{u.app}</span>
                <div className="h-2 min-w-0 flex-1 rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-brand"
                    style={{ width: `${Math.max(2, Math.round((u.seconds / maxUsage) * 100))}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-xs text-slate-400">
                  {formatDuration(u.seconds)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold">任务专注</h2>
        <p className="mb-3 text-xs text-slate-400">
          按任务归并的专注时长（模型自动归类）。删除或添加任务名可校正模型的归类。
        </p>
        {focusList.length === 0 ? (
          <p className="py-2 text-sm text-slate-400">暂无任务归类，积累一些工作记录后自动出现。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {focusList.map((f) => (
              <li key={f.task} className="group flex items-center gap-3 text-sm">
                <span className="w-36 shrink-0 truncate text-slate-600">{f.task}</span>
                <div className="h-2 min-w-0 flex-1 rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-brand/70"
                    style={{ width: `${Math.max(2, Math.round((f.seconds / maxFocus) * 100))}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-xs text-slate-400">
                  {f.seconds ? formatDuration(f.seconds) : '—'}
                </span>
                <button
                  className="invisible shrink-0 px-1 text-xs text-slate-400 group-hover:visible hover:text-red-500"
                  onClick={() => void hideTask(f.task)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
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
      </section>

      <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">历史报告</h2>
        {reports.length === 0 ? (
          <p className="py-2 text-sm text-slate-400">暂无报告，去生成第一份吧。</p>
        ) : (
          <ul className="flex flex-col">
            {reports.map((r) => (
              <li key={r.id} className="border-b border-slate-100 py-2 last:border-b-0">
                <div className="flex items-center gap-3">
                  <button
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-slate-500"
                    onClick={() => setOpenReportId(openReportId === r.id ? null : r.id)}
                  >
                    {r.title}
                  </button>
                  <span className="shrink-0 text-xs text-slate-400">{r.createdAt.slice(5, 16).replace('T', ' ')}</span>
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
                {openReportId === r.id && (
                  <pre className="mt-2 rounded-lg bg-slate-50 px-4 py-3 text-xs leading-6 whitespace-pre-wrap text-slate-700">
                    {r.content}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {note && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm text-white shadow-lg">
          {note}
        </div>
      )}
    </div>
  )
}
