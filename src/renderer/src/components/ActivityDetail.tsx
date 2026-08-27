// 日报页「活动明细」视图：屏幕感知最近 48 小时的 6 小时摘要 / 10 分钟活动块 / 未摘要片段。
// 原为独立的「历史」页；采集开关、App 黑名单、清理原始数据那部分随合并移到了设置 → 屏幕感知。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  historyPresetMs,
  type HistoryActivityStat,
  type HistoryRangePreset,
  type HistoryRecentResult,
  type HistoryStatus,
  type HistorySummaryView
} from '@shared/history'
import { api } from '../api'
import { Section, Segmented } from './ui'

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

/** 预设区间转成 datetime-local 输入框认的本地时间串 */
function rangeForPreset(preset: HistoryRangePreset, nowMs = Date.now()): { from: string; to: string } {
  return {
    from: localInputValue(nowMs - historyPresetMs(preset)),
    to: localInputValue(nowMs)
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

export default function ActivityDetail(): React.JSX.Element {
  const initialRange = rangeForPreset('all')
  const [status, setStatus] = useState<HistoryStatus | null>(null)
  const [result, setResult] = useState<HistoryRecentResult | null>(null)
  const [range, setRange] = useState(initialRange)
  const [rangeDraft, setRangeDraft] = useState(initialRange)
  const [preset, setPreset] = useState<HistoryRangePreset>('all')
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
      const next = await api.historyRecent({ from, to, limit: 80, includeSegments: true })
      setResult(next)
      await loadStatus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [loadStatus, range.from, range.to])

  useEffect(() => {
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

  const choosePreset = (next: HistoryRangePreset): void => {
    const nextRange = rangeForPreset(next)
    setPreset(next)
    setRangeDraft(nextRange)
    setRange(nextRange)
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
    <>
      <Section title="时间范围" desc="本机保留最近 48 小时的活动摘要，不展示键盘正文或敏感原文。采集开关与清理在设置 → 屏幕感知。">
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
          <div className="flex flex-wrap items-center gap-2 text-xs">
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
          </div>
          <div className="flex-1" />
          <button
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            disabled={busy || loading || !enabled}
            onClick={() => void summarize()}
          >
            {busy ? '处理中…' : '立即摘要'}
          </button>
        </div>
      </Section>

      {(error || notice) && (
        <div className={`rounded-lg px-3 py-2 text-xs ${error ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {error ?? notice}
        </div>
      )}

      <div className="text-xs text-slate-400">
        {result ? `${formatDate(result.range.from)} 至 ${formatDate(result.range.to)} · ${result.fallbackUsed ? '含未摘要片段' : '摘要覆盖'}` : '正在读取…'}
      </div>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-surface py-12 text-center text-sm text-slate-400">加载中…</div>
      ) : (
        <>
          <Section title="6 小时摘要" desc="汇总 10 分钟工作焦点和进展，不重新读取原始事件。">
            {result?.sixHour.length ? (
              // 只露出约 2 个摘要块的高度，其余滚动查看，避免一口气撑满整页
              <div className="max-h-[22rem] overflow-y-auto">
                {result.sixHour.map((item) => <SummaryCard key={item.id} item={item} />)}
              </div>
            ) : <ResultEmpty enabled={enabled} />}
          </Section>

          <Section title="10 分钟活动块" desc="优先展示这一时段的主要工作与进展；App、事件类型和来源仅作为可展开证据。">
            {dayGroups.length ? dayGroups.map(([day, items]) => (
              <div key={day}>
                <h3 className="border-b border-slate-100 py-2 text-xs font-medium text-slate-500">{day === 'unknown' ? '未知日期' : formatDate(`${day}T12:00:00`)}</h3>
                {/* 每天只露出约 2 个活动块的高度，其余在块内滚动 */}
                <div className="max-h-[17rem] overflow-y-auto">
                  {items.map((item) => <SummaryCard key={item.id} item={item} compact />)}
                </div>
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
    </>
  )
}
