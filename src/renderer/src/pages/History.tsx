import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, HistoryAppSelection } from '@shared/types'
import {
  normalizeHistoryHost,
  type HistoryActivityStat,
  type HistoryDeleteResult,
  type HistoryRecentResult,
  type HistoryStatus,
  type HistorySummaryView
} from '@shared/history'
import { api } from '../api'
import { Section, Segmented } from '../components/ui'

const RETENTION_MS = 48 * 60 * 60 * 1000

type Preset = '10m' | '1h' | '1d' | 'all'

function localInputValue(timestampMs: number): string {
  const d = new Date(timestampMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isoFromLocal(value: string): string | null {
  if (!value) return null
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function rangeForPreset(preset: Preset, nowMs = Date.now()): { from: string; to: string } {
  const duration = preset === '10m' ? 10 * 60 * 1000 : preset === '1h' ? 60 * 60 * 1000 : preset === '1d' ? 86_400_000 : RETENTION_MS
  return {
    from: localInputValue(nowMs - duration),
    to: localInputValue(nowMs)
  }
}

function isoRangeForPreset(preset: Preset, nowMs = Date.now()): { from: string; to: string } {
  const duration = preset === '10m' ? 10 * 60 * 1000 : preset === '1h' ? 60 * 60 * 1000 : preset === '1d' ? 86_400_000 : RETENTION_MS
  return {
    from: new Date(nowMs - duration).toISOString(),
    to: new Date(nowMs).toISOString()
  }
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '未知时间'
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
    : '未知日期'
}

function localDayKey(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'unknown'
  const d = new Date(timestamp)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function confidenceLabel(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function sourceLabel(source: HistorySummaryView['source']): string {
  if (source === 'model') return '模型补充'
  if (source === 'hybrid') return '本地 + 模型'
  return '本地统计'
}

function activityLabel(value: string): string {
  const labels: Record<string, string> = {
    app_activated: '应用切换',
    window_changed: '窗口变化',
    ax_focus_changed: '焦点变化',
    ax_attribute_changed: '属性变化',
    click: '点击',
    right_click: '右键',
    drag: '拖拽',
    shortcut: '快捷键',
    selection_changed: '选择',
    input_activity: '输入活动',
    heartbeat: '心跳'
  }
  return labels[value] ?? value
}

function appList(apps: string[]): React.JSX.Element | null {
  if (!apps.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {apps.slice(0, 8).map((app) => (
        <span key={app} className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
          {app}
        </span>
      ))}
    </div>
  )
}

function ActivityStats({ stats }: { stats?: HistoryActivityStat[] }): React.JSX.Element | null {
  const safeStats = stats ?? []
  if (!safeStats.length) return null
  return (
    <details className="mt-2 text-xs text-slate-500">
      <summary className="cursor-pointer select-none text-slate-400">查看事件证据统计</summary>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {safeStats.map((stat) => (
          <span key={stat.type}>
            {activityLabel(stat.type)} × {stat.count}
          </span>
        ))}
      </div>
    </details>
  )
}

function EvidenceDetails({ item }: { item: HistorySummaryView }): React.JSX.Element {
  return (
    <details className="mt-3 text-xs text-slate-500">
      <summary className="cursor-pointer select-none text-slate-400">查看辅助证据</summary>
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {appList(item.apps)}
          <span>证据 {item.evidenceCount}{item.meaningfulEvidenceCount ? `（有效 ${item.meaningfulEvidenceCount}）` : ''}</span>
          <span>来源 {item.sourceSegmentIds.slice(0, 2).join('、') || '待补齐'}</span>
        </div>
        {!!item.taskClues.length && (
          <div>观察到的线索：{item.taskClues.slice(0, 4).join('、')}</div>
        )}
        <ActivityStats stats={item.activityTypeCounts} />
      </div>
    </details>
  )
}

function SummaryCard({ item, compact = false }: { item: HistorySummaryView; compact?: boolean }): React.JSX.Element {
  return (
    <article className={`border-b border-slate-100 py-4 last:border-b-0 ${compact ? 'first:pt-1' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>{formatTime(item.startAt)}–{formatTime(item.endAt)}</span>
            <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-brand">{item.level === '6h' ? '6 小时' : '10 分钟'}</span>
            <span>{sourceLabel(item.source)}</span>
          </div>
          <div className="mt-1.5">
            <div className="text-[11px] font-medium text-brand">工作焦点</div>
            <p className="text-sm leading-6 text-slate-700">{item.summary || item.focus || '暂无可读摘要，等待下一轮处理。'}</p>
            {item.focusTask && <p className="mt-1 text-xs text-slate-500">对应任务：{item.focusTask}</p>}
            {item.progress && <p className="mt-1 text-xs text-slate-500">进展：{item.progress}</p>}
            {item.outcome && <p className="mt-1 text-xs text-slate-500">结果线索：{item.outcome}</p>}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs text-slate-400">
          <div className="font-medium text-slate-600">{confidenceLabel(item.confidence)}</div>
          <div className="mt-0.5">置信度</div>
        </div>
      </div>
      <EvidenceDetails item={item} />
    </article>
  )
}

function ResultEmpty({ enabled }: { enabled: boolean }): React.JSX.Element {
  return (
    <div className="py-12 text-center text-sm text-slate-400">
      {enabled ? '当前范围还没有可展示的活动。' : 'History 尚未开启，请先在设置中开启 History v2。'}
    </div>
  )
}

function deletionMessage(result: HistoryDeleteResult): string {
  const segments = result.deletedSegmentIds.length
  const summaries = result.deletedSummaryIds.length
  const records = result.deletedWorkRecordIds.length
  return `已清理 ${segments} 个片段、${summaries} 条摘要${records ? `、${records} 条工作记录` : ''}`
}

export default function History(): React.JSX.Element {
  const initialRange = rangeForPreset('all')
  const [status, setStatus] = useState<HistoryStatus | null>(null)
  const [result, setResult] = useState<HistoryRecentResult | null>(null)
  const [range, setRange] = useState(initialRange)
  const [rangeDraft, setRangeDraft] = useState(initialRange)
  const [preset, setPreset] = useState<Preset>('all')
  const [queryDraft, setQueryDraft] = useState('')
  const [appDraft, setAppDraft] = useState('')
  const [query, setQuery] = useState('')
  const [app, setApp] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [excludedApps, setExcludedApps] = useState<HistoryAppSelection[]>([])
  const [includedHostDraft, setIncludedHostDraft] = useState('')
  const [excludedHostDraft, setExcludedHostDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadStatus = useCallback(async (): Promise<HistoryStatus | null> => {
    try {
      const next = await api.historyStatus()
      setStatus(next)
      return next
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return null
    }
  }, [])

  const loadHistory = useCallback(async (): Promise<void> => {
    const from = isoFromLocal(range.from)
    const to = isoFromLocal(range.to)
    if (!from || !to || from >= to) {
      setError('时间范围无效，请选择起止时间。')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const options = { from, to, limit: 80, includeSegments: true }
      const next = query || app
        ? await api.historySearch({ ...options, query, app })
        : await api.historyRecent(options)
      setResult(next)
      await loadStatus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [app, loadStatus, query, range.from, range.to])

  useEffect(() => {
    void api.getSettings().then((next) => {
      setSettings(next)
      setExcludedApps(next.historyExcludedApps ?? [])
      setIncludedHostDraft((next.historyIncludedHosts ?? []).join('、'))
      setExcludedHostDraft((next.historyExcludedHosts ?? []).join('、'))
    })
    void loadHistory()
    const timer = window.setInterval(() => {
      void loadStatus()
    }, 8000)
    const offHistory = api.on('guzi-assistant:history-updated', () => {
      void loadHistory()
    })
    return () => {
      window.clearInterval(timer)
      offHistory()
    }
  }, [loadHistory, loadStatus])

  const applyRange = (): void => {
    const from = isoFromLocal(rangeDraft.from)
    const to = isoFromLocal(rangeDraft.to)
    if (!from || !to || from >= to) {
      setError('时间范围无效，请选择起止时间。')
      return
    }
    setRange({ ...rangeDraft })
    setPreset('all')
  }

  const choosePreset = (next: Preset): void => {
    const nextRange = rangeForPreset(next)
    setPreset(next)
    setRangeDraft(nextRange)
    setRange(nextRange)
  }

  const submitSearch = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setQuery(queryDraft.trim())
    setApp(appDraft.trim())
  }

  const togglePause = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = status?.paused ? await api.historyResume() : await api.historyPause()
      setStatus(next)
      setNotice(next.paused ? 'History 已暂停' : 'History 已恢复')
      await loadHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const summarize = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const from = isoFromLocal(range.from)
      const to = isoFromLocal(range.to)
      const next = await api.historySummarize({ from, to, limit: 80, includeSegments: true })
      setResult(next)
      await loadStatus()
      const tenMinuteChanged = next.run.tenMinuteChanged ?? next.run.tenMinuteSummaries
      const sixHourChanged = next.run.sixHourChanged ?? next.run.sixHourSummaries
      setNotice(
        `摘要完成：10 分钟变更 ${tenMinuteChanged} 条（扫描 ${next.run.tenMinuteSummaries}），6 小时变更 ${sixHourChanged} 条（扫描 ${next.run.sixHourSummaries}）`
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const cleanRange = async (kind: Preset): Promise<void> => {
    const label = kind === 'all' ? '全部保留期历史' : kind === '10m' ? '最近 10 分钟' : kind === '1h' ? '最近 1 小时' : '最近 1 天'
    if (!window.confirm(`将永久删除${label}及其摘要和派生工作记录，无法恢复。确定继续？`)) return
    setBusy(true)
    setError(null)
    try {
      let deleted: HistoryDeleteResult
      if (kind === 'all') deleted = await api.historyClear()
      else {
        const current = isoRangeForPreset(kind)
        deleted = await api.historyDeleteRange(current)
      }
      setNotice(deletionMessage(deleted))
      await loadHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const cleanCurrentRange = async (): Promise<void> => {
    const from = isoFromLocal(range.from)
    const to = isoFromLocal(range.to)
    if (!from || !to || from >= to) {
      setError('当前时间范围无效，无法清理。')
      return
    }
    if (!window.confirm('将永久删除当前时间范围内的 History、摘要和派生工作记录，无法恢复。确定继续？')) return
    setBusy(true)
    setError(null)
    try {
      const deleted = await api.historyDeleteRange({ from, to })
      setNotice(deletionMessage(deleted))
      await loadHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const saveExcludedApps = async (list: HistoryAppSelection[], notice = '已保存历史 App 黑名单'): Promise<boolean> => {
    const ok = await api.saveSettings({ historyExcludedApps: list })
    if (ok) {
      setExcludedApps(list)
      setSettings((current) => current ? { ...current, historyExcludedApps: list } : current)
      setNotice(notice)
      return true
    }
    setError('保存历史 App 黑名单失败')
    return false
  }

  const chooseExcludedApps = async (): Promise<void> => {
    setError(null)
    try {
      const picked = await api.historyPickApps()
      if (!picked) return
      const merged = [...excludedApps]
      const existing = new Set(merged.map((item) => item.bundleId.toLowerCase()))
      for (const item of picked) {
        if (!existing.has(item.bundleId.toLowerCase())) {
          existing.add(item.bundleId.toLowerCase())
          merged.push(item)
        }
      }
      await saveExcludedApps(merged, picked.length ? '已加入历史 App 黑名单' : '历史 App 黑名单未变更')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const removeExcludedApp = async (bundleId: string): Promise<void> => {
    const next = excludedApps.filter((item) => item.bundleId !== bundleId)
    await saveExcludedApps(next, '已移除历史 App 黑名单项')
  }

  const parseHostList = (value: string): string[] => [...new Set(
    value
      .split(/[,，、;；\s]+/)
      .map((item) => normalizeHistoryHost(item))
      .filter((item): item is string => item !== null)
  )]

  const saveIncludedHosts = async (): Promise<void> => {
    const list = parseHostList(includedHostDraft)
    const ok = await api.saveSettings({ historyIncludedHosts: list })
    if (ok) {
      setSettings((current) => current ? { ...current, historyIncludedHosts: list } : current)
      setNotice(list.length ? '已保存网站 include 名单' : '已清空网站 include 名单')
    } else setError('保存网站 include 名单失败')
  }

  const saveExcludedHosts = async (): Promise<void> => {
    const list = parseHostList(excludedHostDraft)
    const ok = await api.saveSettings({ historyExcludedHosts: list })
    if (ok) {
      setSettings((current) => current ? { ...current, historyExcludedHosts: list } : current)
      setNotice(list.length ? '已保存网站排除名单' : '已清空网站排除名单')
    } else setError('保存网站排除名单失败')
  }

  const dayGroups = useMemo(() => {
    const groups = new Map<string, HistorySummaryView[]>()
    for (const item of result?.tenMinute ?? []) {
      const key = localDayKey(item.startAt)
      const list = groups.get(key) ?? []
      list.push(item)
      groups.set(key, list)
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [result?.tenMinute])

  const enabled = status?.enabled ?? false

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-8 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">历史</h1>
          <p className="mt-1 text-sm text-slate-400">本机保留最近 48 小时的活动摘要，不展示键盘正文或敏感原文。</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-1 text-xs ${!enabled ? 'bg-slate-100 text-slate-500' : status?.paused ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
            {!enabled ? '未开启' : status?.paused ? '已暂停' : '采集中'}
          </span>
          <button
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            disabled={!enabled || busy}
            onClick={() => void togglePause()}
          >
            {status?.paused ? '恢复' : '暂停'}
          </button>
        </div>
      </div>

      <Section title="时间范围与筛选">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={preset}
            onChange={choosePreset}
            options={[
              ['10m', '10 分钟'],
              ['1h', '1 小时'],
              ['1d', '1 天'],
              ['all', '48 小时']
            ]}
          />
          <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={submitSearch}>
            <input
              type="datetime-local"
              value={rangeDraft.from}
              onChange={(event) => setRangeDraft((current) => ({ ...current, from: event.target.value }))}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
            />
            <span className="text-slate-400">至</span>
            <input
              type="datetime-local"
              value={rangeDraft.to}
              onChange={(event) => setRangeDraft((current) => ({ ...current, to: event.target.value }))}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
            />
            <button type="button" onClick={applyRange} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
              应用范围
            </button>
            <input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="搜索任务线索或窗口主题"
              className="min-w-48 rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
            />
            <input
              value={appDraft}
              onChange={(event) => setAppDraft(event.target.value)}
              placeholder="仅显示 App"
              className="w-32 rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
            />
            <button type="submit" className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark">
              筛选
            </button>
          </form>
        </div>
        {settings && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <div>
                <div className="text-slate-500">历史 App 黑名单</div>
                <div className="mt-1 text-[11px] text-slate-400">选中的 App 不会写入 History；按 Bundle ID 精确匹配。</div>
              </div>
              <button type="button" onClick={() => void chooseExcludedApps()} disabled={busy} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                选择 App
              </button>
            </div>
            {excludedApps.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {excludedApps.map((item) => (
                  <span key={item.bundleId} className="inline-flex items-center gap-1.5 rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
                    <span title={item.bundleId}>{item.name}</span>
                    <button type="button" aria-label={`移除 ${item.name}`} onClick={() => void removeExcludedApp(item.bundleId)} className="text-rose-500 hover:text-rose-800">移除</button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-slate-400">尚未排除任何 App。</p>
            )}
            <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="shrink-0 text-slate-500">只采集网站 host</span>
              <input
                value={includedHostDraft}
                onChange={(event) => setIncludedHostDraft(event.target.value)}
                placeholder="如：docs.example.com，留空 = 不限网站"
                className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
              />
              <button type="button" onClick={() => void saveIncludedHosts()} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                保存网站 include
              </button>
            </label>
            <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="shrink-0 text-slate-500">采集排除网站 host</span>
              <input
                value={excludedHostDraft}
                onChange={(event) => setExcludedHostDraft(event.target.value)}
                placeholder="如：private.example.com"
                className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
              />
              <button type="button" onClick={() => void saveExcludedHosts()} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                保存网站排除
              </button>
            </label>
            <p className="mt-1.5 text-[11px] text-slate-400">网站规则只比较 http/https 的 host，可匹配子域名；完整 URL、路径和查询参数会被拒绝，也不会保存。没有 host 的普通 App 事件不受网站 include 影响。</p>
          </div>
        )}
      </Section>

      {(error || notice) && (
        <div className={`rounded-lg px-3 py-2 text-xs ${error ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {error ?? notice}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          {result ? `${formatDate(result.range.from)} 至 ${formatDate(result.range.to)} · ${result.fallbackUsed ? '含未摘要片段' : '摘要覆盖'}` : '正在读取…'}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50" disabled={busy || loading || !enabled} onClick={() => void summarize()}>
            {busy ? '处理中…' : '立即摘要'}
          </button>
          <button className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50" disabled={busy || !enabled} onClick={() => void cleanRange('10m')}>
            清理 10 分钟
          </button>
          <button className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50" disabled={busy || !enabled} onClick={() => void cleanRange('1h')}>
            清理 1 小时
          </button>
          <button className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50" disabled={busy || !enabled} onClick={() => void cleanRange('1d')}>
            清理 1 天
          </button>
          <button className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50" disabled={busy || !enabled} onClick={() => void cleanCurrentRange()}>
            清理当前范围
          </button>
          <button className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50" disabled={busy || !enabled} onClick={() => void cleanRange('all')}>
            清空 48 小时
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-surface py-12 text-center text-sm text-slate-400">加载 History…</div>
      ) : (
        <>
          <Section title="6 小时摘要" desc="汇总 10 分钟工作焦点和进展，不重新读取原始事件。">
            {result?.sixHour.length ? result.sixHour.map((item) => <SummaryCard key={item.id} item={item} />) : <ResultEmpty enabled={enabled} />}
          </Section>

          <Section title="10 分钟活动块" desc="优先展示这一时段的主要工作与进展；App、事件类型和来源仅作为可展开证据。">
            {dayGroups.length ? dayGroups.map(([day, items]) => (
              <div key={day}>
                <h3 className="border-b border-slate-100 py-2 text-xs font-medium text-slate-500">{day === 'unknown' ? '未知日期' : formatDate(`${day}T12:00:00`)}</h3>
                {items.map((item) => <SummaryCard key={item.id} item={item} compact />)}
              </div>
            )) : <ResultEmpty enabled={enabled} />}
          </Section>

          {!!result?.segments.length && (
            <Section title="尚未摘要的活动片段" desc="这些片段只展示统计信息，等待下一轮摘要。">
              <div className="divide-y divide-slate-100">
                {result.segments.map((segment) => (
                  <div key={segment.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs">
                    <div>
                      <div className="font-medium text-slate-600">{formatTime(segment.bucketStart)}–{formatTime(segment.bucketEnd)} · {segment.id}</div>
                      <div className="mt-1 text-slate-400">事件 {segment.eventCount} · 有效 {segment.meaningfulEventCount} · 已抑制 {segment.suppressedEventCount}</div>
                      <ActivityStats stats={segment.activityTypeCounts} />
                    </div>
                    <div className="flex flex-wrap gap-1.5">{segment.apps.slice(0, 6).map((appName) => <span key={appName} className="rounded-md bg-slate-100 px-2 py-0.5 text-slate-500">{appName}</span>)}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
