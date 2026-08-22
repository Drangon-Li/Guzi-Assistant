import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppCategoryOverride, AppUsageEntry, TaskRecord, WorkRecord } from '@shared/types'
import { dayKey, formatDuration, groupWorkPeriods, periodLabel } from '@shared/work-report'
import { buildOverrideMap, categoryOf, deepWorkSeconds, productiveRuns } from '@shared/attention'
import { api } from '../api'
import { Section } from '../components/ui'
import GrainEar from '../components/GrainEar'
import brandMark from '../assets/agent-avatar.png'

const ACTIVE_STATUS = new Set(['not_started', 'scheduled', 'in_progress', 'overdue'])

interface Props {
  tasks: TaskRecord[]
  userName: string
  onNavigate: (page: 'reports' | 'settings') => void
}

function greeting(h: number): string {
  if (h >= 5 && h < 8) return '清晨好'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  if (h < 23) return '晚上好'
  return '夜深了'
}

/** 「今日」主界面：动态问候 + 数据叙事 + 今日概览 + 谷穗时间轴 + 最近工作记录。 */
export default function Home({ tasks, userName, onNavigate }: Props): React.JSX.Element {
  const [records, setRecords] = useState<WorkRecord[]>([])
  const [ytdRecords, setYtdRecords] = useState<WorkRecord[]>([])
  const [overrides, setOverrides] = useState<AppCategoryOverride[]>([])
  const [usage, setUsage] = useState<AppUsageEntry[]>([])
  const [senseOn, setSenseOn] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [note, setNote] = useState('')

  const today = dayKey(new Date())
  const yesterday = dayKey(new Date(Date.now() - 86_400_000))

  const load = useCallback(() => {
    void api.listWorkRecords(today).then(setRecords)
    void api.listWorkRecords(yesterday).then(setYtdRecords)
    void api.appUsageSummary(today).then(setUsage)
    void api.appCategoryOverrides().then(setOverrides)
  }, [today, yesterday])

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
    return api.on('guzi-assistant:settings-updated', loadSettings)
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

  // 谷穗：按小时数工作记录条数（谷粒饱满度）
  const byHour = Array<number>(24).fill(0)
  for (const r of records) {
    const h = Number(r.startAt.slice(11, 13))
    if (h >= 0 && h < 24) byHour[h]++
  }
  const grainCount = byHour.filter((n) => n > 0).length

  // 数据叙事：今天专注多久、结了几粒谷；有可比数据时对比昨天此刻
  const narrative = useMemo(() => {
    if (!records.length)
      return senseOn
        ? '新的一天，谷穗还没结粒。开始工作后，我会帮你把每段专注攒成收获。'
        : '开启屏幕感知后，我会帮你把每段专注攒成收获。'
    const map = buildOverrideMap(overrides)
    const cat = (app: string): ReturnType<typeof categoryOf> => categoryOf(app, map)
    const deep = deepWorkSeconds(productiveRuns(records, cat))
    const nowHm = new Date().toTimeString().slice(0, 5)
    const deepYtd = deepWorkSeconds(
      productiveRuns(ytdRecords.filter((r) => r.startAt.slice(11, 16) <= nowHm), cat)
    )
    let s = deep
      ? `今天已专注 ${formatDuration(deep)}，谷穗结了 ${grainCount} 粒`
      : `今天谷穗结了 ${grainCount} 粒`
    const diff = deep - deepYtd
    if (deepYtd > 0 && Math.abs(diff) >= 600)
      s += `，比昨天此时${diff > 0 ? '多' : '少'}专注 ${formatDuration(Math.abs(diff))}`
    return s + '。'
  }, [records, ytdRecords, overrides, senseOn, grainCount])

  const recent = groupWorkPeriods(records).slice(-5).reverse()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div className="flex items-start gap-4">
        <img src={brandMark} alt="" className="mt-1 size-12 shrink-0 rounded-2xl border border-brand-soft bg-brand-soft/50 p-2" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">
            {greeting(new Date().getHours())}，{userName}
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-slate-400">{narrative}</p>
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

      <Section
        title="今日概览"
        actions={
          <div className="flex gap-2">
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              onClick={() => void scanNow()}
              disabled={scanning}
            >
              {scanning ? '扫描中…' : '立即扫描屏幕'}
            </button>
            <button
              className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark"
              onClick={() => onNavigate('reports')}
            >
              去生成日报
            </button>
          </div>
        }
      >
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
      </Section>

      <Section
        title="今日麦田"
        desc="地平线是一天的时间轴：有活动的小时长出一株麦子，记录越多穗子越长、结粒越多。划过麦穗数一数。"
      >
        <GrainEar byHour={byHour} />
        {records.length === 0 && (
          <p className="pt-1 text-center text-xs text-slate-400">地里还没长东西，开始工作后自然会发芽。</p>
        )}
      </Section>

      <Section
        title="最近工作记录"
        actions={
          <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => onNavigate('reports')}>
            查看全部 →
          </button>
        }
      >
        {recent.length === 0 ? (
          <p className="py-3 text-sm text-slate-400">
            {senseOn
              ? '还没有工作记录。持续监控运行中，开始工作后稍等片刻即可看到。'
              : '开启屏幕感知后，这里会自动记录你在做什么。'}
          </p>
        ) : (
          <ul className="flex flex-col">
            {recent.map((p) => (
              <li
                key={p.start + p.summary}
                className="flex items-baseline gap-3 border-b border-slate-100 py-2 text-sm last:border-b-0"
              >
                <span className="w-24 shrink-0 font-mono text-xs text-slate-400">{periodLabel(p)}</span>
                {p.app && (
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{p.app}</span>
                )}
                <span className="min-w-0 flex-1 truncate leading-5">{p.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {note && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm text-white shadow-lg">
          {note}
        </div>
      )}
    </div>
  )
}
