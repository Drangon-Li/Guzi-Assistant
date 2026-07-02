import { useEffect, useState } from 'react'
import { api } from '../api'

const input =
  'w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

/**
 * 个人记忆（原记忆页「个人记忆」Tab，随记忆页拆解迁入个人页）：
 * 基本画像（长期身份定义，手动维护 + AI 小幅演进）+ 近期行为画像（AI 从活动归纳，可手动修正）。
 */
export default function PersonalMemory(): React.JSX.Element {
  const [base, setBase] = useState('')
  const [recent, setRecent] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [dirtyBase, setDirtyBase] = useState(false)
  const [dirtyRecent, setDirtyRecent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyBase, setBusyBase] = useState(false)
  const [note, setNote] = useState('')

  const flash = (m: string): void => {
    setNote(m)
    window.setTimeout(() => setNote(''), 3000)
  }

  useEffect(() => {
    void api.getPersonalMemory().then((m) => {
      setBase(m.base)
      setRecent(m.recent)
      setUpdatedAt(m.updatedAt)
    })
  }, [])

  const save = async (part: 'base' | 'recent'): Promise<void> => {
    const m = await api.setPersonalMemory(part, part === 'base' ? base : recent)
    setUpdatedAt(m.updatedAt)
    if (part === 'base') setDirtyBase(false)
    else setDirtyRecent(false)
    flash('已保存')
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      const m = await api.refreshPersonalMemory('recent')
      setRecent(m.recent)
      setUpdatedAt(m.updatedAt)
      setDirtyRecent(false)
      flash('近期画像已更新')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const refreshBase = async (): Promise<void> => {
    setBusyBase(true)
    try {
      const m = await api.refreshPersonalMemory('base')
      setBase(m.base)
      setUpdatedAt(m.updatedAt)
      setDirtyBase(false)
      flash('基本画像已更新')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyBase(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">基本画像</h3>
            <p className="text-xs text-slate-400">
              你是谁：身份、方向、长期项目与偏好。长期维护，只存本地；AI 总结会在你写的基础上小幅演进。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              onClick={() => void refreshBase()}
              disabled={busyBase}
            >
              {busyBase ? '正在总结…' : 'AI 总结'}
            </button>
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              onClick={() => void save('base')}
              disabled={!dirtyBase}
            >
              保存
            </button>
          </div>
        </div>
        <textarea
          className={`${input} min-h-[120px] resize-y font-mono leading-6`}
          placeholder="例如：博士生，研究方向蛋白质设计；同时开发谷子助手；常用 VS Code / Notion…"
          value={base}
          onChange={(e) => {
            setBase(e.target.value)
            setDirtyBase(true)
          }}
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">近期行为画像</h3>
            <p className="text-xs text-slate-400">最近在推进什么：AI 从近期活动与任务自动归纳，可手动修正。</p>
          </div>
          <button
            className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-50"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? '正在归纳…' : '立即更新'}
          </button>
        </div>
        <textarea
          className={`${input} min-h-[180px] resize-y font-mono leading-6`}
          placeholder="还没有近期画像。点「立即更新」让 AI 从你的活动里归纳。"
          value={recent}
          onChange={(e) => {
            setRecent(e.target.value)
            setDirtyRecent(true)
          }}
        />
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>{updatedAt ? `上次更新：${updatedAt.replace('T', ' ')}` : '尚未生成'}</span>
          <button
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            onClick={() => void save('recent')}
            disabled={!dirtyRecent}
          >
            保存修改
          </button>
        </div>
      </section>

      {note && <div className="text-xs text-emerald-600">{note}</div>}
    </div>
  )
}
