import { useCallback, useEffect, useState } from 'react'
import type { AppUsageEntry, TaskRecord, WorkRecord } from '@shared/types'
import { dayKey, formatDuration } from '@shared/work-report'
import { api } from '../api'
import brandMark from '../assets/agent-avatar.png'

const ACTIVE_STATUS = new Set(['not_started', 'scheduled', 'in_progress', 'overdue'])

interface Props {
  tasks: TaskRecord[]
  onNavigate: (page: 'reports' | 'settings') => void
}

/** 「今日」主界面：口号 + 隐私承诺 + 今日概览 + 时段记录 + 最近工作记录。 */
export default function Home({ tasks, onNavigate }: Props): React.JSX.Element {
  const [records, setRecords] = useState<WorkRecord[]>([])
  const [usage, setUsage] = useState<AppUsageEntry[]>([])
  const [senseOn, setSenseOn] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [note, setNote] = useState('')

  const today = dayKey(new Date())

  const load = useCallback(() => {
    void api.listWorkRecords(today).then(setRecords)
    void api.appUsageSummary(today).then(setUsage)
  }, [today])

  useEffect(() => {
    load()
    const t = window.setInterval(load, 60_000) // 工作记录没有广播事件，轮询兜底
    return () => window.clearInterval(t)
  }, [load])

  useEffect(() => {
    const loadSettings = (): void => {
      void api.getSettings().then((s) => setSenseOn(s.screenSenseEnabled))
    }
    loadSettings()
    return api.on('eshell:settings-updated', loadSettings)
  }, [])

  const scanNow = async (): Promise<void> => {
    setScanning(true)
    try {
      const r = await api.screenScan()
      setNote(r.message)
      load()
    } finally {
      setScanning(false)
      window.setTimeout(() => setNote(''), 4000)
    }
  }

  const totalSeconds = usage.reduce((n, u) => n + u.seconds, 0)
  const doneToday = tasks.filter(
    (t) => t.status === 'done' && t.updatedAt.slice(0, 10) === today
  ).length
  const openCount = tasks.filter(
    (t) => ACTIVE_STATUS.has(t.status) && t.belongsToUser !== 'no'
  ).length

  // 时段热力：按小时数工作记录条数
  const byHour = Array<number>(24).fill(0)
  for (const r of records) {
    const h = Number(r.createdAt.slice(11, 13))
    if (h >= 0 && h < 24) byHour[h]++
  }
  const heatClass = (n: number): string =>
    n === 0 ? 'bg-slate-100' : n === 1 ? 'bg-slate-300' : n <= 3 ? 'bg-slate-500' : 'bg-slate-700'

  const recent = records.slice(-5).reverse()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10 titlebar-pad">
      <div className="flex items-start gap-4">
        <img src={brandMark} alt="" className="mt-1 size-14 shrink-0 rounded-2xl border border-slate-200 p-2" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">你只管工作，待办和日报交给我</h1>
          <p className="mt-1.5 text-sm leading-6 text-slate-400">
            静默感知屏幕，帮你捕获待办、判断「哪些事是你的事」，顺手记好工作轨迹、写好每一份日报。
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2 text-xs text-slate-500">
            <span className="rounded-full border border-slate-200 px-2.5 py-1">截图用完即弃</span>
            <span className="rounded-full border border-slate-200 px-2.5 py-1">只上传文字，不传截图</span>
            <span className="rounded-full border border-slate-200 px-2.5 py-1">数据仅存本地</span>
          </div>
        </div>
      </div>

      {!senseOn && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <span>屏幕感知未开启：开启后才会自动捕获待办与工作记录（检测走云端，消耗积分）。</span>
          <button
            className="shrink-0 rounded-lg border border-amber-300 px-3 py-1.5 text-xs hover:bg-amber-100"
            onClick={() => onNavigate('settings')}
          >
            去设置开启
          </button>
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">今日概览</h2>
          <div className="flex gap-2">
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              onClick={() => void scanNow()}
              disabled={scanning}
            >
              {scanning ? '扫描中…' : '立即扫描屏幕'}
            </button>
            <button
              className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white hover:bg-black"
              onClick={() => onNavigate('reports')}
            >
              去生成日报
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: '工作记录', value: `${records.length} 条` },
            { label: '屏幕活跃', value: totalSeconds ? formatDuration(totalSeconds) : '—' },
            { label: '今日完成', value: `${doneToday} 项` },
            { label: '待办中', value: `${openCount} 项` }
          ].map((s) => (
            <div key={s.label} className="rounded-lg bg-slate-50 px-4 py-3">
              <div className="text-lg font-semibold">{s.value}</div>
              <div className="mt-0.5 text-xs text-slate-400">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">时段记录</h2>
          <span className="flex items-center gap-1 text-[10px] text-slate-400">
            少
            <span className="size-2.5 rounded-sm bg-slate-100" />
            <span className="size-2.5 rounded-sm bg-slate-300" />
            <span className="size-2.5 rounded-sm bg-slate-500" />
            <span className="size-2.5 rounded-sm bg-slate-700" />
            多
          </span>
        </div>
        <div className="flex gap-1">
          {byHour.map((n, h) => (
            <div key={h} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className={`h-7 w-full rounded ${heatClass(n)}`} title={`${h}:00 · ${n} 条记录`} />
              {h % 6 === 0 && <span className="text-[10px] text-slate-400">{h}:00</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">最近工作记录</h2>
          <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => onNavigate('reports')}>
            查看全部 →
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="py-3 text-sm text-slate-400">
            {senseOn
              ? '还没有工作记录。持续监控运行中，开始工作后稍等片刻即可看到。'
              : '开启屏幕感知后，这里会自动记录你在做什么。'}
          </p>
        ) : (
          <ul className="flex flex-col">
            {recent.map((r) => (
              <li key={r.id} className="flex items-baseline gap-3 border-b border-slate-100 py-2 text-sm last:border-b-0">
                <span className="shrink-0 font-mono text-xs text-slate-400">{r.createdAt.slice(11, 16)}</span>
                {r.app && (
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{r.app}</span>
                )}
                <span className="min-w-0 flex-1 truncate leading-5">{r.content}</span>
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
