import { useEffect, useState } from 'react'
import { memoryToPlain, plainToMemory } from '@shared/work-report'
import { api } from '../api'

const input =
  'w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

/**
 * 个人记忆（个人页）：基本画像 + 近期行为画像，均为点击展开。
 * 展示/编辑用无 Markdown 纯文本（memoryToPlain），保存时转回「- 」要点存储（plainToMemory），
 * 存储格式保持模型好读，prompt 注入不受影响。
 */
export default function PersonalMemory(): React.JSX.Element {
  const [base, setBase] = useState('')
  const [recent, setRecent] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const flash = (m: string): void => {
    setNote(m)
    window.setTimeout(() => setNote(''), 3000)
  }

  useEffect(() => {
    void api.getPersonalMemory().then((m) => {
      setBase(memoryToPlain(m.base))
      setRecent(memoryToPlain(m.recent))
      setUpdatedAt(m.updatedAt)
    })
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <MemorySection
        title="基本画像"
        desc="你是谁：身份、方向、长期项目与偏好。长期维护，只存本地。"
        placeholder="例如：博士生，研究方向蛋白质设计；同时开发谷子助手；常用 VS Code / Notion…"
        value={base}
        refreshLabel="AI 总结"
        busyLabel="正在总结…"
        onChange={setBase}
        onSave={async () => {
          const m = await api.setPersonalMemory('base', plainToMemory(base))
          setUpdatedAt(m.updatedAt)
          flash('已保存')
        }}
        onRefresh={async () => {
          try {
            const m = await api.refreshPersonalMemory('base')
            setBase(memoryToPlain(m.base))
            setUpdatedAt(m.updatedAt)
            flash('基本画像已更新')
          } catch (e) {
            flash(e instanceof Error ? e.message : String(e))
          }
        }}
      />
      <MemorySection
        title="近期行为画像"
        desc="最近在推进什么：AI 从近期活动与任务自动归纳，可手动修正。"
        placeholder="还没有近期画像。点「立即更新」让 AI 从你的活动里归纳。"
        value={recent}
        refreshLabel="立即更新"
        busyLabel="正在归纳…"
        onChange={setRecent}
        onSave={async () => {
          const m = await api.setPersonalMemory('recent', plainToMemory(recent))
          setUpdatedAt(m.updatedAt)
          flash('已保存')
        }}
        onRefresh={async () => {
          try {
            const m = await api.refreshPersonalMemory('recent')
            setRecent(memoryToPlain(m.recent))
            setUpdatedAt(m.updatedAt)
            flash('近期画像已更新')
          } catch (e) {
            flash(e instanceof Error ? e.message : String(e))
          }
        }}
      />
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{updatedAt ? `上次更新：${updatedAt.replace('T', ' ')}` : '尚未生成'}</span>
        {note && <span className="text-emerald-600">{note}</span>}
      </div>
    </div>
  )
}

interface SectionProps {
  title: string
  desc: string
  placeholder: string
  value: string
  refreshLabel: string
  busyLabel: string
  onChange: (v: string) => void
  onSave: () => Promise<void>
  onRefresh: () => Promise<void>
}

/** 单个画像：折叠头（标题 + 一行预览），点击展开编辑区。 */
function MemorySection(p: SectionProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  const preview = p.value.split('\n').find(Boolean) ?? ''

  const save = async (): Promise<void> => {
    await p.onSave()
    setDirty(false)
  }
  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await p.onRefresh()
      setDirty(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-slate-200">
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
        onClick={() => setOpen(!open)}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{p.title}</div>
          <div className="mt-0.5 truncate text-xs text-slate-400">
            {preview || '（空）点击展开填写或让 AI 生成'}
          </div>
        </div>
        <span
          className={`shrink-0 text-xs text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ›
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-slate-100 px-4 py-3">
          <p className="text-xs text-slate-400">{p.desc}</p>
          <textarea
            className={`${input} min-h-[140px] resize-y leading-6`}
            placeholder={p.placeholder}
            value={p.value}
            onChange={(e) => {
              p.onChange(e.target.value)
              setDirty(true)
            }}
          />
          <div className="flex justify-end gap-2">
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              onClick={() => void refresh()}
              disabled={busy}
            >
              {busy ? p.busyLabel : p.refreshLabel}
            </button>
            <button
              className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
              onClick={() => void save()}
              disabled={!dirty}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
