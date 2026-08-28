// 成就页：成就墙 + 解锁详情。
//
// 被未启用插件锁住的成就照样显示（灰的），点开会说清楚「装了哪个插件才有」——
// 这是 Market 之外的第二个发现入口，也是「插件扩展插件」对用户可见的那一面。
import { useCallback, useEffect, useState } from 'react'
import type { AchievementSummary, AchievementView } from '@shared/achievement'
import { findPlugin } from '@shared/plugin-registry'
import { api } from '../../api'
import Modal from '../../components/Modal'
import { Segmented } from '../../components/ui'
import GrainIcon from './GrainIcons'
import type { PluginPageProps } from '../types'

interface ListPayload {
  views: AchievementView[]
  summary: AchievementSummary
  newly: string[]
}

type Filter = 'all' | 'unlocked' | 'locked'

export default function AchievementPage(_props: PluginPageProps): React.JSX.Element {
  const [views, setViews] = useState<AchievementView[]>([])
  const [summary, setSummary] = useState<AchievementSummary>({ unlocked: 0, available: 0, total: 0 })
  const [celebrate, setCelebrate] = useState<AchievementView[]>([])
  const [detail, setDetail] = useState<AchievementView | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async () => {
    const res = await api.plugin<ListPayload>('achievement', 'list')
    setViews(res.views)
    setSummary(res.summary)
    if (res.newly.length) {
      setCelebrate(res.views.filter((v) => res.newly.includes(v.key)))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const shown = views.filter((v) =>
    filter === 'unlocked' ? v.unlocked : filter === 'locked' ? !v.unlocked : true
  )

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">成就</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            只奖励记录和坚持本身。没有断签清零，中断了也不会掉进度。
          </p>
          <p className="mt-2 text-sm text-slate-500 tabular-nums">
            已解锁 <span className="font-medium text-brand">{summary.unlocked}</span> / {summary.available}
            {summary.total > summary.available && (
              <span className="ml-2 text-xs text-slate-400">
                另有 {summary.total - summary.available} 条要装插件才有
              </span>
            )}
          </p>
        </div>
        <Segmented
          value={filter}
          options={[
            ['all', '全部'],
            ['unlocked', '已解锁'],
            ['locked', '未解锁']
          ]}
          onChange={setFilter}
        />
      </header>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
        {shown.map((v) => (
          <button
            key={v.key}
            onClick={() => setDetail(v)}
            className={`flex flex-col items-center rounded-xl border p-4 text-center transition-colors ${
              v.unlocked
                ? 'border-brand/40 bg-brand-soft text-brand hover:border-brand'
                : v.locked
                  ? 'border-slate-100 bg-slate-50/60 text-slate-300'
                  : 'border-slate-200 bg-surface text-slate-400 hover:border-slate-300'
            }`}
          >
            <GrainIcon name={v.icon} className={`size-8 ${v.unlocked ? '' : 'opacity-50'}`} />
            <span
              className={`mt-2 text-sm font-medium ${v.unlocked ? 'text-slate-700' : 'text-slate-400'}`}
            >
              {v.name}
            </span>
            {v.locked ? (
              <span className="mt-1 text-[11px]">需要「{findPlugin(v.plugin ?? '')?.name}」</span>
            ) : v.unlocked ? (
              <span className="mt-1 text-[11px] text-slate-400 tabular-nums">
                {v.unlockedAt?.slice(0, 10)}
              </span>
            ) : (
              <span className="mt-1 w-full">
                <span className="block h-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-brand/50"
                    style={{ width: `${Math.round(v.progress * 100)}%` }}
                  />
                </span>
                <span className="mt-1 block text-[11px] tabular-nums">
                  {v.current} / {v.target}
                </span>
              </span>
            )}
          </button>
        ))}
      </div>

      {detail && (
        <Modal panelClass="w-[24rem] rounded-xl bg-surface p-6 shadow-xl" onClose={() => setDetail(null)}>
          {(close) => (
            <div>
              <div className="flex items-start gap-4">
                <GrainIcon
                  name={detail.icon}
                  className={`size-10 shrink-0 ${detail.unlocked ? 'text-brand' : 'text-slate-300'}`}
                />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold">{detail.name}</h2>
                  <p className="mt-0.5 text-sm text-slate-500">{detail.desc}</p>
                </div>
              </div>

              <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
                <div className="mb-1 text-xs font-medium text-slate-400">怎么拿到</div>
                {detail.howTo}
              </div>

              {detail.locked ? (
                <p className="mt-3 text-xs text-slate-400">
                  这条成就来自「{findPlugin(detail.plugin ?? '')?.name}」插件，去市场启用后才会开始计数。
                </p>
              ) : detail.unlocked ? (
                <p className="mt-3 text-xs text-slate-400 tabular-nums">
                  {detail.unlockedAt?.replace('T', ' ')} 解锁
                </p>
              ) : (
                <p className="mt-3 text-xs text-slate-400 tabular-nums">
                  当前进度 {detail.current} / {detail.target}
                </p>
              )}

              <div className="mt-5 flex justify-end">
                <button onClick={close} className="rounded-lg px-3 py-1.5 text-sm text-slate-500">
                  关闭
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {celebrate.length > 0 && (
        <Modal
          panelClass="w-[22rem] rounded-xl bg-surface p-6 text-center shadow-xl"
          onClose={() => setCelebrate([])}
        >
          {(close) => (
            <div>
              <div className="mb-3 flex justify-center gap-3 text-brand">
                {celebrate.slice(0, 4).map((v) => (
                  <GrainIcon key={v.key} name={v.icon} className="size-10" />
                ))}
              </div>
              <h2 className="text-base font-semibold">
                {celebrate.length > 1 ? `解锁了 ${celebrate.length} 条成就` : '解锁了一条成就'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {celebrate.map((v) => v.name).join('、')}
              </p>
              <button
                onClick={close}
                className="mt-5 rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white"
              >
                收下
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
