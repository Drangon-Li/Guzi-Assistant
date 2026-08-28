// 成就页：成就墙 + 分级 + 分类 + 最近解锁 + 快达成。
//
// 被未启用插件锁住的成就照样显示（灰的），点开会说清楚「装了哪个插件才有」——
// 这是 Market 之外的第二个发现入口，也是「插件扩展插件」对用户可见的那一面。
import { useCallback, useEffect, useState } from 'react'
import type {
  AchievementSummary,
  AchievementTier,
  AchievementView
} from '@shared/achievement'
import { closestToUnlock, groupAchievements, recentlyUnlocked } from '@shared/achievement'
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

/** 铜银金：只用明度和一点点色相区分，不引入新的品牌色。 */
const TIER_RING: Record<AchievementTier, string> = {
  bronze: 'border-amber-300/70',
  silver: 'border-slate-300',
  gold: 'border-brand'
}
const TIER_TEXT: Record<AchievementTier, string> = {
  bronze: 'text-amber-600',
  silver: 'text-slate-500',
  gold: 'text-brand'
}
const TIER_LABEL: Record<AchievementTier, string> = {
  bronze: '铜',
  silver: '银',
  gold: '金'
}

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
    if (res.newly.length) setCelebrate(res.views.filter((v) => res.newly.includes(v.key)))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const shown = views.filter((v) =>
    filter === 'unlocked' ? v.unlocked : filter === 'locked' ? !v.unlocked : true
  )
  const groups = groupAchievements(shown)
  const recent = recentlyUnlocked(views)
  const closest = closestToUnlock(views)
  const overall = summary.available > 0 ? summary.unlocked / summary.available : 0

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">成就</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              同一件事有铜、银、金三档。只奖励记录和坚持本身，没有断签清零。
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
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-surface px-5 py-4 shadow-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-500">
              已解锁 <span className="text-lg font-semibold text-brand tabular-nums">{summary.unlocked}</span>
              <span className="text-slate-400"> / {summary.available}</span>
            </span>
            {summary.total > summary.available && (
              <span className="text-xs text-slate-400">
                另有 {summary.total - summary.available} 条要装插件才有
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand transition-all"
              style={{ width: `${Math.round(overall * 100)}%` }}
            />
          </div>
        </div>
      </header>

      {recent.length > 0 && filter === 'all' && (
        <section className="mb-5">
          <h2 className="mb-2 text-xs font-medium text-slate-400">最近解锁</h2>
          <div className="flex flex-wrap gap-2">
            {recent.map((v) => (
              <button
                key={v.key}
                onClick={() => setDetail(v)}
                className={`flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm shadow-sm transition-colors hover:border-brand ${TIER_RING[v.tier]}`}
              >
                <GrainIcon name={v.icon} className={`size-5 ${TIER_TEXT[v.tier]}`} />
                <span className="font-medium">{v.name}</span>
                <span className="text-[11px] text-slate-400 tabular-nums">
                  {v.unlockedAt?.slice(5, 10)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {closest.length > 0 && filter === 'all' && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium text-slate-400">快拿到了</h2>
          <div className="space-y-2">
            {closest.map((v) => (
              <button
                key={v.key}
                onClick={() => setDetail(v)}
                className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-surface px-4 py-2.5 text-left shadow-sm hover:border-brand"
              >
                <GrainIcon name={v.icon} className="size-5 shrink-0 text-slate-400" />
                <span className="w-32 shrink-0 truncate text-sm font-medium">{v.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-brand/60"
                    style={{ width: `${Math.round(v.progress * 100)}%` }}
                  />
                </span>
                <span className="w-20 shrink-0 text-right text-xs text-slate-400 tabular-nums">
                  {v.current} / {v.target}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {groups.map(({ group, items }) => (
        <section key={group} className="mb-6">
          <h2 className="mb-2 flex items-baseline gap-2 text-xs font-medium text-slate-400">
            {group}
            <span className="tabular-nums text-slate-300">
              {items.filter((v) => v.unlocked).length}/{items.filter((v) => !v.locked).length}
            </span>
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
            {items.map((v) => (
              <button
                key={v.key}
                onClick={() => setDetail(v)}
                className={`flex flex-col items-center rounded-xl border-2 p-4 text-center transition-colors ${
                  v.unlocked
                    ? `${TIER_RING[v.tier]} bg-surface hover:shadow-sm`
                    : v.locked
                      ? 'border-slate-100 bg-slate-50/60'
                      : 'border-slate-200/60 bg-surface hover:border-slate-300'
                }`}
              >
                <GrainIcon
                  name={v.icon}
                  className={`size-8 ${
                    v.unlocked ? TIER_TEXT[v.tier] : v.locked ? 'text-slate-200' : 'text-slate-300'
                  }`}
                />
                <span
                  className={`mt-2 text-sm font-medium ${
                    v.unlocked ? 'text-slate-700' : 'text-slate-400'
                  }`}
                >
                  {v.name}
                </span>
                {v.locked ? (
                  <span className="mt-1 text-[11px] text-slate-300">
                    需要「{findPlugin(v.plugin ?? '')?.name}」
                  </span>
                ) : v.unlocked ? (
                  <span className={`mt-1 text-[11px] ${TIER_TEXT[v.tier]}`}>
                    {TIER_LABEL[v.tier]} · {v.unlockedAt?.slice(0, 10)}
                  </span>
                ) : (
                  <span className="mt-1 w-full">
                    <span className="block h-1 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full bg-brand/50"
                        style={{ width: `${Math.round(v.progress * 100)}%` }}
                      />
                    </span>
                    <span className="mt-1 block text-[11px] text-slate-400 tabular-nums">
                      {v.current} / {v.target}
                    </span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}

      {detail && (
        <Modal panelClass="w-[24rem] rounded-xl bg-surface p-6 shadow-xl" onClose={() => setDetail(null)}>
          {(close) => (
            <div>
              <div className="flex items-start gap-4">
                <GrainIcon
                  name={detail.icon}
                  className={`size-10 shrink-0 ${detail.unlocked ? TIER_TEXT[detail.tier] : 'text-slate-300'}`}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold">{detail.name}</h2>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${TIER_TEXT[detail.tier]} bg-slate-50`}
                    >
                      {TIER_LABEL[detail.tier]}档 · {detail.group}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-500">{detail.desc}</p>
                </div>
              </div>

              <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
                <div className="mb-1 text-xs font-medium text-slate-400">怎么拿到</div>
                {detail.howTo}
              </div>

              {detail.prerequisite && !detail.unlocked && (
                <p className="mt-3 text-xs text-slate-400">
                  同一条线上的「{detail.prerequisite}」还没拿到，那个会先解锁。
                </p>
              )}

              {detail.locked ? (
                <p className="mt-3 text-xs text-slate-400">
                  这条成就来自「{findPlugin(detail.plugin ?? '')?.name}」插件，去市场启用后才会开始计数。
                </p>
              ) : detail.unlocked ? (
                <p className="mt-3 text-xs text-slate-400 tabular-nums">
                  {detail.unlockedAt?.replace('T', ' ')} 解锁
                </p>
              ) : (
                <div className="mt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-brand/60"
                      style={{ width: `${Math.round(detail.progress * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-slate-400 tabular-nums">
                    当前进度 {detail.current} / {detail.target}
                  </p>
                </div>
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
              <div className="mb-3 flex justify-center gap-3">
                {celebrate.slice(0, 4).map((v) => (
                  <GrainIcon key={v.key} name={v.icon} className={`size-10 ${TIER_TEXT[v.tier]}`} />
                ))}
              </div>
              <h2 className="text-base font-semibold">
                {celebrate.length > 1 ? `解锁了 ${celebrate.length} 条成就` : '解锁了一条成就'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">{celebrate.map((v) => v.name).join('、')}</p>
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
