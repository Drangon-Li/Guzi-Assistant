// 设置页「屏幕感知」里的 History 数据管控：App 黑名单 + 按范围清理原始数据。
// 原在独立的「历史」页，那一页的内容部分已并入日报页的「活动明细」。
import { useEffect, useState } from 'react'
import type { HistoryAppSelection } from '@shared/types'
import { historyDeletionMessage, isoRangeForPreset, type HistoryRangePreset } from '@shared/history'
import { api } from '../../api'
import { Section } from '../ui'

const CLEAN_PRESETS: [HistoryRangePreset, string][] = [
  ['10m', '最近 10 分钟'],
  ['1h', '最近 1 小时'],
  ['1d', '最近 1 天'],
  ['all', '全部 48 小时']
]

export default function HistoryDataSection({
  flash
}: {
  flash: (msg: string) => void
}): React.JSX.Element {
  const [excludedApps, setExcludedApps] = useState<HistoryAppSelection[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.getSettings().then((s) => setExcludedApps(s.historyExcludedApps ?? []))
  }, [])

  const saveExcludedApps = async (list: HistoryAppSelection[], msg: string): Promise<void> => {
    const ok = await api.saveSettings({ historyExcludedApps: list })
    if (!ok) {
      flash('保存历史 App 黑名单失败')
      return
    }
    setExcludedApps(list)
    flash(msg)
  }

  const chooseExcludedApps = async (): Promise<void> => {
    try {
      const picked = await api.historyPickApps()
      if (!picked) return
      const merged = [...excludedApps]
      const existing = new Set(merged.map((item) => item.bundleId.toLowerCase()))
      for (const item of picked) {
        if (existing.has(item.bundleId.toLowerCase())) continue
        existing.add(item.bundleId.toLowerCase())
        merged.push(item)
      }
      await saveExcludedApps(merged, picked.length ? '已加入历史 App 黑名单' : '历史 App 黑名单未变更')
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const cleanRange = async (kind: HistoryRangePreset, label: string): Promise<void> => {
    if (!window.confirm(`将永久删除${label}的 History、摘要和派生工作记录，无法恢复。确定继续？`)) return
    setBusy(true)
    try {
      const deleted =
        kind === 'all' ? await api.historyClear() : await api.historyDeleteRange(isoRangeForPreset(kind))
      flash(historyDeletionMessage(deleted))
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section title="History App 黑名单" desc="选中的 App 不会写入 History；按 Bundle ID 精确匹配。">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400">
            {excludedApps.length ? `已排除 ${excludedApps.length} 个 App` : '尚未排除任何 App。'}
          </p>
          <button
            type="button"
            onClick={() => void chooseExcludedApps()}
            disabled={busy}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            选择 App
          </button>
        </div>
        {excludedApps.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {excludedApps.map((item) => (
              <span key={item.bundleId} className="inline-flex items-center gap-1.5 rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
                <span title={item.bundleId}>{item.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${item.name}`}
                  onClick={() =>
                    void saveExcludedApps(
                      excludedApps.filter((x) => x.bundleId !== item.bundleId),
                      '已移除历史 App 黑名单项'
                    )
                  }
                  className="text-rose-500 hover:text-rose-800"
                >
                  移除
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="清理 History 原始数据" desc="连同摘要与由它派生的工作记录一起删除，不可恢复。日常查看在日报 → 活动明细。">
        <div className="flex flex-wrap gap-2">
          {CLEAN_PRESETS.map(([kind, label]) => (
            <button
              key={kind}
              className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${
                kind === 'all'
                  ? 'border-red-200 text-red-600 hover:bg-red-50'
                  : 'border-amber-200 text-amber-700 hover:bg-amber-50'
              }`}
              disabled={busy}
              onClick={() => void cleanRange(kind, label)}
            >
              清理{label}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}
