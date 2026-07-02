import { useCallback, useEffect, useState } from 'react'
import type { AppUsageEntry, ReportRecord, WorkRecord } from '@shared/types'
import { dayKey, formatDuration, groupWorkPeriods, periodLabel } from '@shared/work-report'
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

  const today = dayKey(new Date())

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 3000)
  }

  const loadDay = useCallback((d: string) => {
    void api.listWorkRecords(d).then(setRecords)
    void api.appUsageSummary(d).then(setUsage)
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
            className="rounded-lg bg-ink px-4 py-1.5 text-xs text-white hover:bg-black disabled:opacity-50"
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
          <ul className="flex flex-col">
            {groupWorkPeriods(records).map((p) => (
              <li
                key={p.start + p.summary}
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
                    className="h-2 rounded-full bg-slate-700"
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
