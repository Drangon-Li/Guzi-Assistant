// 今日页卡片：现在该做什么，以及接下来是什么。
import { useEffect, useState } from 'react'
import { dayKey } from '@shared/work-report'
import { minutesToLabel, sortBlocks, type TimeBlock } from '@shared/timeblock'
import { api } from '../../api'

export default function TimeblockTodayCard(): React.JSX.Element | null {
  const [blocks, setBlocks] = useState<TimeBlock[]>([])
  const [nowMin, setNowMin] = useState(() => new Date().getHours() * 60 + new Date().getMinutes())

  useEffect(() => {
    const day = dayKey(new Date())
    void api
      .plugin<{ blocks: TimeBlock[] }>('timeblock', 'day', day)
      .then((r) => setBlocks(r.blocks))
    // 分钟级刷新就够：卡片只关心「现在落在哪一块」
    const timer = window.setInterval(() => {
      const d = new Date()
      setNowMin(d.getHours() * 60 + d.getMinutes())
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!blocks.length) return null

  const sorted = sortBlocks(blocks)
  const current = sorted.find((b) => b.startMin <= nowMin && nowMin < b.endMin)
  const next = sorted.find((b) => b.startMin > nowMin)

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-2 text-xs font-medium text-slate-400">作息</div>
      {current ? (
        <div>
          <div className="text-sm font-medium">{current.title}</div>
          <div className="mt-0.5 text-xs text-slate-400 tabular-nums">
            {minutesToLabel(current.startMin)}–{minutesToLabel(current.endMin)}
            <span className="ml-2">还剩 {current.endMin - nowMin} 分钟</span>
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-400">这会儿没有安排</div>
      )}
      {next && (
        <div className="mt-2.5 border-t border-slate-100 pt-2 text-xs text-slate-400">
          接下来 <span className="text-slate-600">{next.title}</span>
          <span className="ml-1.5 tabular-nums">{minutesToLabel(next.startMin)}</span>
        </div>
      )}
    </div>
  )
}
