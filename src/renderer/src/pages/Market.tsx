// 市场：按需启用扩展功能。
//
// 谷子助手的核心是「捕获 → 判断 → 收进日程」。作息、专注、打卡、成就都不是核心，
// 只喜欢基本功能的人不该被它们打扰——所以默认一个都不启用，导航里也不出现。
import { useCallback, useEffect, useState } from 'react'
import type { PluginState } from '@shared/plugin-manifest'
import { lockedCountByPlugin } from '@shared/achievement'
import { findPlugin } from '@shared/plugin-registry'
import { api } from '../api'
import { PLUGIN_UI } from '../plugins'

const CATEGORY_LABELS: Record<string, string> = {
  planning: '规划',
  focus: '专注',
  habit: '习惯',
  reward: '激励',
  note: '记录'
}

const nameOf = (id: string): string => findPlugin(id)?.name ?? id

export default function Market(): React.JSX.Element {
  const [states, setStates] = useState<PluginState[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 3000)
  }

  const load = useCallback(async () => {
    setStates(await api.listPlugins())
  }, [])

  useEffect(() => {
    void load()
    const off = api.on('guzi-assistant:plugins-updated', () => void load())
    return off
  }, [load])

  const enable = async (s: PluginState): Promise<void> => {
    const id = s.manifest.id
    if (s.requires.length) {
      const names = s.requires.map(nameOf).join('、')
      if (!window.confirm(`「${s.manifest.name}」需要「${names}」，会一起启用。继续？`)) return
    }
    setBusy(id)
    const res = await api.enablePlugin(id)
    setStates(res.states)
    setBusy(null)
    flash(
      res.added && res.added.length > 1
        ? `已启用 ${res.added.map(nameOf).join('、')}`
        : `已启用「${s.manifest.name}」，去左侧导航看看`
    )
  }

  const disable = async (s: PluginState): Promise<void> => {
    const id = s.manifest.id
    if (s.breaks.length) {
      const names = s.breaks.map(nameOf).join('、')
      if (!window.confirm(`「${names}」依赖「${s.manifest.name}」，会一起停用。继续？`)) return
    }
    setBusy(id)
    const res = await api.disablePlugin(id)
    setStates(res.states)
    setBusy(null)
    flash('已停用。数据还留着，重新启用就回来。')
  }

  const uninstall = async (s: PluginState): Promise<void> => {
    if (
      !window.confirm(
        `将永久删除「${s.manifest.name}」的全部数据，无法恢复。\n\n只是不想在导航里看到它的话，停用就够了。确定删除？`
      )
    )
      return
    setBusy(s.manifest.id)
    const res = await api.uninstallPlugin(s.manifest.id)
    setStates(res.states)
    setBusy(null)
    flash('数据已删除')
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">市场</h1>
        <p className="mt-0.5 max-w-2xl text-xs text-slate-400">
          这些是可选的扩展功能，默认都不启用。启用后会出现在左侧导航里，停用即消失——
          核心的捕获、日程、日报不受任何影响。
        </p>
      </header>

      <div className="space-y-3">
        {states.map((s) => {
          const id = s.manifest.id
          const Icon = PLUGIN_UI[id]?.Icon
          const open = expanded === id
          const achievements = lockedCountByPlugin(id)
          return (
            <div
              key={id}
              className={`rounded-xl border bg-surface p-5 shadow-sm transition-colors ${
                s.enabled ? 'border-brand/40' : 'border-slate-200'
              }`}
            >
              <div className="flex items-start gap-4">
                <div
                  className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
                    s.enabled ? 'bg-brand-soft text-brand' : 'bg-slate-50 text-slate-400'
                  }`}
                >
                  {Icon && <Icon />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">{s.manifest.name}</h2>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {CATEGORY_LABELS[s.manifest.category] ?? s.manifest.category}
                    </span>
                    <span className="text-[10px] text-slate-300 tabular-nums">
                      v{s.manifest.version}
                    </span>
                    {s.enabled && (
                      <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">
                        已启用
                      </span>
                    )}
                  </div>

                  <p className="mt-1 text-sm text-slate-500">{s.manifest.summary}</p>

                  {open && (
                    <p className="mt-2 text-sm leading-relaxed text-slate-500">
                      {s.manifest.description}
                    </p>
                  )}

                  <div className="mt-2 space-y-1 text-xs">
                    {!s.available && (
                      <p className="text-amber-600">
                        需要 {s.manifest.minAppVersion} 及以上版本，先去设置里检查更新。
                      </p>
                    )}
                    {!s.enabled && s.requires.length > 0 && (
                      <p className="text-slate-400">
                        需要先启用 <span className="text-slate-600">{s.requires.map(nameOf).join('、')}</span>
                        ，启用时会一起装上。
                      </p>
                    )}
                    {s.enabled && s.breaks.length > 0 && (
                      <p className="text-slate-400">
                        <span className="text-slate-600">{s.breaks.map(nameOf).join('、')}</span>{' '}
                        依赖它，停用会一起停。
                      </p>
                    )}
                    {s.missing.length > 0 && (
                      <p className="text-slate-400">
                        装了 <span className="text-slate-600">{s.missing.map(nameOf).join('、')}</span>{' '}
                        会更好用
                        {id === 'achievement' && `（每个插件都会带来一批新成就）`}。
                      </p>
                    )}
                    {achievements > 0 && !s.enabled && (
                      <p className="text-slate-400">启用后，成就墙会多 {achievements} 条。</p>
                    )}
                  </div>

                  <button
                    onClick={() => setExpanded(open ? null : id)}
                    className="mt-2 text-xs text-slate-400 hover:text-slate-600"
                  >
                    {open ? '收起' : '了解更多'}
                  </button>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {s.enabled ? (
                    <button
                      disabled={busy === id}
                      onClick={() => void disable(s)}
                      className="rounded-lg border border-slate-200 px-4 py-1.5 text-sm text-slate-500 hover:border-slate-300 disabled:opacity-50"
                    >
                      停用
                    </button>
                  ) : (
                    <button
                      disabled={busy === id || !s.available}
                      onClick={() => void enable(s)}
                      className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                    >
                      启用
                    </button>
                  )}
                  {!s.enabled && (
                    <button
                      disabled={busy === id}
                      onClick={() => void uninstall(s)}
                      className="text-[11px] text-slate-300 hover:text-red-500 disabled:opacity-50"
                      title="永久删除这个插件存下的数据"
                    >
                      清除数据
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-8 text-xs text-slate-300">
        插件的数据和核心数据一样只存在本机。停用只是把它从导航里摘掉，数据仍在；
        「清除数据」才会真正删除，且不可恢复。
      </p>

      {note && (
        <div
          key={note}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2 text-sm text-white shadow-lg"
        >
          {note}
        </div>
      )}
    </div>
  )
}
