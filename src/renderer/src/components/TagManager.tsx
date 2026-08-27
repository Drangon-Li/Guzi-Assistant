// 标签管理面板。标签没有独立实体——它只存在于任务的 tags 数组，加上设置里的三份名单
// （重点/隐藏/手动创建），所以这里每个操作都是「遍历任务改 tags」+「改名单」两件事一起做。
import { useMemo, useState } from 'react'
import type { TaskRecord } from '@shared/types'
import { api } from '../api'
import Modal from './Modal'

interface TagLists {
  starredTags?: string[]
  hiddenTags?: string[]
  customTags?: string[]
}

interface Props {
  tasks: TaskRecord[]
  starredTags: string[]
  hiddenTags: string[]
  customTags: string[]
  onSettings: (patch: TagLists) => void
  onClose: () => void
}

export default function TagManager({
  tasks, starredTags, hiddenTags, customTags, onSettings, onClose
}: Props): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [newTag, setNewTag] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const stats = useMemo(() => {
    const m = new Map<string, { active: number; total: number }>()
    for (const tag of customTags) m.set(tag, { active: 0, total: 0 })
    for (const task of tasks)
      for (const tag of task.tags) {
        const s = m.get(tag) ?? { active: 0, total: 0 }
        s.total += 1
        if (task.status !== 'done' && task.status !== 'ignored') s.active += 1
        m.set(tag, s)
      }
    return [...m.entries()]
      .map(([tag, s]) => ({ tag, ...s }))
      .sort((a, b) => b.active - a.active || b.total - a.total || a.tag.localeCompare(b.tag))
  }, [tasks, customTags])

  const allSelected = selected.size > 0 && selected.size === stats.length

  const toggleSelect = (tag: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })

  const removeTags = async (tags: string[]): Promise<void> => {
    const gone = new Set(tags)
    setBusy(true)
    for (const task of tasks) {
      const next = task.tags.filter((t) => !gone.has(t))
      if (next.length !== task.tags.length) await api.updateTask(task.id, { tags: next })
    }
    onSettings({
      starredTags: starredTags.filter((t) => !gone.has(t)),
      hiddenTags: hiddenTags.filter((t) => !gone.has(t)),
      customTags: customTags.filter((t) => !gone.has(t))
    })
    setSelected(new Set())
    setConfirmDelete(false)
    setBusy(false)
  }

  const rename = async (from: string): Promise<void> => {
    const to = draft.trim().replace(/^#/, '').replace(/,/g, '')
    setRenaming(null)
    if (!to || to === from) return
    setBusy(true)
    for (const task of tasks) {
      if (!task.tags.includes(from)) continue
      // 改成一个已存在的标签就是合并；去重免得同一任务出现两个同名标签
      await api.updateTask(task.id, { tags: [...new Set(task.tags.map((t) => (t === from ? to : t)))] })
    }
    const swap = (list: string[]): string[] => [...new Set(list.map((t) => (t === from ? to : t)))]
    onSettings({ starredTags: swap(starredTags), hiddenTags: swap(hiddenTags), customTags: swap(customTags) })
    setBusy(false)
  }

  const create = (): void => {
    const name = newTag.trim().replace(/^#/, '').replace(/,/g, '')
    setNewTag('')
    if (!name || stats.some((s) => s.tag === name)) return
    onSettings({ customTags: [...customTags, name] })
  }

  const setHiddenFor = (tags: string[], hidden: boolean): void => {
    const set = new Set(tags)
    onSettings({
      hiddenTags: hidden ? [...new Set([...hiddenTags, ...tags])] : hiddenTags.filter((t) => !set.has(t))
    })
  }

  return (
    <Modal
      panelClass="flex max-h-[80vh] w-[560px] flex-col rounded-xl bg-surface p-5 shadow-2xl"
      onClose={onClose}
    >
      {(close) => (
        <>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-base font-semibold">标签管理</h3>
            <button className="text-slate-400 hover:text-slate-600" onClick={close}>
              ✕
            </button>
          </div>
          <p className="mb-3 text-xs text-slate-400">
            隐藏只是让标签不出现在日程页的筛选栏，任务上的标签保持原样；删除会把标签从所有任务上摘掉。
          </p>

          <div className="mb-3 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
              placeholder="新建标签（还没有任务在用也会出现在筛选栏）"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
              }}
            />
            <button
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              onClick={create}
            >
              新建
            </button>
          </div>

          {stats.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">还没有任何标签。</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ul className="flex flex-col">
                {stats.map((s) => (
                  <li
                    key={s.tag}
                    className="group flex items-center gap-2.5 border-b border-slate-100 py-2 text-sm last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      className="shrink-0 accent-brand"
                      checked={selected.has(s.tag)}
                      onChange={() => toggleSelect(s.tag)}
                    />
                    {renaming === s.tag ? (
                      <input
                        autoFocus
                        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:border-slate-400 focus:outline-none"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void rename(s.tag)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void rename(s.tag)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                      />
                    ) : (
                      <span
                        className={`min-w-0 flex-1 truncate ${hiddenTags.includes(s.tag) ? 'text-slate-400 line-through' : ''}`}
                      >
                        #{s.tag}
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-slate-400">
                      {s.active} 未完成 · {s.total} 总计
                    </span>
                    <button
                      title={starredTags.includes(s.tag) ? '取消重点' : '设为重点（谷子建议加分）'}
                      className={`shrink-0 px-0.5 ${
                        starredTags.includes(s.tag) ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500'
                      }`}
                      onClick={() =>
                        onSettings({
                          starredTags: starredTags.includes(s.tag)
                            ? starredTags.filter((t) => t !== s.tag)
                            : [...starredTags, s.tag]
                        })
                      }
                    >
                      ★
                    </button>
                    <button
                      className="shrink-0 px-1 text-xs text-slate-400 hover:text-slate-600"
                      onClick={() => setHiddenFor([s.tag], !hiddenTags.includes(s.tag))}
                    >
                      {hiddenTags.includes(s.tag) ? '显示' : '隐藏'}
                    </button>
                    <button
                      className="shrink-0 px-1 text-xs text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-slate-600"
                      onClick={() => {
                        setDraft(s.tag)
                        setRenaming(s.tag)
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="shrink-0 px-1 text-xs text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
                      disabled={busy}
                      onClick={() => void removeTags([s.tag])}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {stats.length > 0 && (
            <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 text-xs">
              <button
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50"
                onClick={() => setSelected(allSelected ? new Set() : new Set(stats.map((s) => s.tag)))}
              >
                {allSelected ? '取消全选' : '全选'}
              </button>
              <span className="text-slate-400">已选 {selected.size}</span>
              <div className="flex-1" />
              <button
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                disabled={!selected.size}
                onClick={() => setHiddenFor([...selected], true)}
              >
                隐藏
              </button>
              <button
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                disabled={!selected.size}
                onClick={() => setHiddenFor([...selected], false)}
              >
                显示
              </button>
              <button
                className="rounded-lg border border-red-200 px-3 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
                disabled={!selected.size || busy}
                onClick={() => (confirmDelete ? void removeTags([...selected]) : setConfirmDelete(true))}
              >
                {confirmDelete ? `确认删除 ${selected.size} 个` : '删除'}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
