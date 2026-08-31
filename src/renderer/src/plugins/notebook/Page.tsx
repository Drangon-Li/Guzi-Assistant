// 记事本插件页：左栏分类与标签，中栏笔记列表，右栏编辑器。
// 分类像文件夹（一篇只能在一处），标签像视角（一篇可以有多个），两套并行不互相干扰。
// 管理动作走右键菜单，不在行里堆一排小按钮——三栏本来就窄，按钮挤进去既难点又难看。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildFolderTree,
  collectTags,
  DEFAULT_NOTEBOOK_PREFS,
  filterNotes,
  noteTimeOf,
  sortNotes,
  type FolderNode,
  type NoteFolder,
  type NotebookPrefs,
  type NoteRecord,
  type NoteSummary
} from '@shared/notebook'
import { api } from '../../api'
import ContextMenu, { type MenuEntry } from '../../components/ContextMenu'
import NoteEditor from './NoteEditor'
import NotebookSettings from './Settings'

const call = <T,>(action: string, ...args: unknown[]): Promise<T> =>
  api.plugin<T>('notebook', action, ...args)

interface Draft {
  id: string | null
  parentId: string | null
  value: string
}

/** 分类名的内联输入。Electron 里没有 window.prompt，新建和重命名都在树里就地完成。 */
function FolderInput({
  value,
  depth,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  depth: number
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <li style={{ paddingLeft: `${depth * 12}px` }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit()
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={onCommit}
        placeholder="分类名"
        className="my-0.5 w-full rounded-lg border border-brand/40 bg-surface px-2 py-1.5 text-sm outline-none"
      />
    </li>
  )
}

/** 分类树的一层。展开状态放在父组件，折叠不会因为重渲染丢失。 */
function FolderRow({
  node,
  depth,
  active,
  expanded,
  draft,
  onToggle,
  onSelect,
  onMenu,
  onDraftChange,
  onDraftCommit,
  onDraftCancel
}: {
  node: FolderNode
  depth: number
  active: string
  expanded: Set<string>
  draft: Draft | null
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onMenu: (e: React.MouseEvent, node: FolderNode) => void
  onDraftChange: (v: string) => void
  onDraftCommit: () => void
  onDraftCancel: () => void
}): React.JSX.Element {
  const open = expanded.has(node.id)
  const hasChildren = node.children.length > 0
  if (draft && draft.id === node.id) {
    return (
      <FolderInput
        value={draft.value}
        depth={depth}
        onChange={onDraftChange}
        onCommit={onDraftCommit}
        onCancel={onDraftCancel}
      />
    )
  }
  return (
    <>
      <li style={{ paddingLeft: `${depth * 12}px` }}>
        <div
          onClick={() => onSelect(node.id)}
          onContextMenu={(e) => onMenu(e, node)}
          className={`flex cursor-default items-center gap-1 rounded-lg py-1.5 pr-2 pl-1 text-sm transition-colors ${
            active === node.id
              ? 'bg-brand-soft font-medium text-slate-900'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <button
            className={`w-4 shrink-0 text-[10px] text-slate-400 ${hasChildren ? '' : 'invisible'}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.id)
            }}
            aria-label={open ? '收起' : '展开'}
          >
            {open ? '▾' : '▸'}
          </button>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.noteCount > 0 && (
            <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">{node.noteCount}</span>
          )}
        </div>
      </li>
      {open &&
        node.children.map((c) => (
          <FolderRow
            key={c.id}
            node={c}
            depth={depth + 1}
            active={active}
            expanded={expanded}
            draft={draft}
            onToggle={onToggle}
            onSelect={onSelect}
            onMenu={onMenu}
            onDraftChange={onDraftChange}
            onDraftCommit={onDraftCommit}
            onDraftCancel={onDraftCancel}
          />
        ))}
      {draft && !draft.id && draft.parentId === node.id && (
        <FolderInput
          value={draft.value}
          depth={depth + 1}
          onChange={onDraftChange}
          onCommit={onDraftCommit}
          onCancel={onDraftCancel}
        />
      )}
    </>
  )
}

export default function NotebookPage(): React.JSX.Element {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [active, setActive] = useState<NoteRecord | null>(null)
  const [folderId, setFolderId] = useState<string>('all')
  const [tag, setTag] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [prefs, setPrefs] = useState<NotebookPrefs>(DEFAULT_NOTEBOOK_PREFS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)

  const reload = useCallback(async (): Promise<void> => {
    const [n, f, p] = await Promise.all([
      call<NoteSummary[]>('list'),
      call<NoteFolder[]>('folders'),
      call<NotebookPrefs>('prefs')
    ])
    setNotes(n)
    setFolders(f)
    setPrefs(p)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const tree = useMemo(() => buildFolderTree(folders, notes), [folders, notes])
  const tags = useMemo(() => collectTags(notes), [notes])
  const visible = useMemo(
    () => sortNotes(filterNotes(notes, { folderId, tag, query })),
    [notes, folderId, tag, query]
  )

  const open = async (id: string): Promise<void> => {
    setActive(await call<NoteRecord | null>('get', id))
  }

  const createNote = async (): Promise<void> => {
    const { id } = await call<{ id: string }>('create', {
      folderId: folderId === 'all' || folderId === 'none' ? null : folderId,
      title: '',
      content: ''
    })
    await reload()
    await open(id)
  }

  /** 编辑器每次改动都进这里：本地立刻更新，落库防抖 600ms，避免每个字符一次 IPC。 */
  const onEdit = (patch: { title?: string; content?: string; tags?: string[] }): void => {
    if (!active) return
    setActive({ ...active, ...patch })
    window.clearTimeout(saveTimer.current)
    const id = active.id
    saveTimer.current = window.setTimeout(() => {
      void call('update', id, patch).then(reload)
    }, 600)
  }

  const removeNote = async (id: string): Promise<void> => {
    if (!window.confirm('删除这篇笔记？删掉就找不回来了。')) return
    await call('destroy', id)
    if (active?.id === id) setActive(null)
    await reload()
  }

  const togglePin = async (n: NoteSummary): Promise<void> => {
    await call('update', n.id, { pinned: !n.pinned })
    await reload()
  }

  const moveNote = async (id: string, target: string | null): Promise<void> => {
    await call('update', id, { folderId: target })
    if (active?.id === id) setActive({ ...active, folderId: target })
    await reload()
  }

  const startCreate = (parentId: string | null): void => {
    if (parentId) setExpanded((s) => new Set(s).add(parentId))
    setDraft({ id: null, parentId, value: '' })
  }

  const startRename = (node: FolderNode): void => setDraft({ id: node.id, parentId: null, value: node.name })

  const commitDraft = async (): Promise<void> => {
    const d = draft
    setDraft(null)
    const name = d?.value.trim()
    if (!d || !name) return
    if (d.id) await call('folder-rename', d.id, name)
    else await call('folder-create', name, d.parentId)
    await reload()
  }

  const deleteFolder = async (node: FolderNode): Promise<void> => {
    if (!window.confirm(`删除分类「${node.name}」？里面的笔记会退回上一级，不会被删除。`)) return
    await call('folder-delete', node.id)
    if (folderId === node.id) setFolderId('all')
    await reload()
  }

  const toggleExpand = (id: string): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const folderMenu = (e: React.MouseEvent, node: FolderNode): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { type: 'header', label: node.name },
        { label: '新建子分类', onClick: () => startCreate(node.id) },
        { label: '重命名', onClick: () => startRename(node) },
        { type: 'separator' },
        { label: '删除分类', danger: true, onClick: () => void deleteFolder(node) }
      ]
    })
  }

  const noteMenu = (e: React.MouseEvent, n: NoteSummary): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { type: 'header', label: n.title },
        { label: n.pinned ? '取消置顶' : '置顶', onClick: () => void togglePin(n) },
        { type: 'separator' },
        { type: 'header', label: '移到分类' },
        { label: '未分类', checked: !n.folderId, onClick: () => void moveNote(n.id, null) },
        ...folders.map(
          (f): MenuEntry => ({
            label: f.name,
            checked: n.folderId === f.id,
            onClick: () => void moveNote(n.id, f.id)
          })
        ),
        { type: 'separator' },
        { label: '删除笔记', danger: true, onClick: () => void removeNote(n.id) }
      ]
    })
  }

  const folderName = (id: string | null): string =>
    id ? (folders.find((f) => f.id === id)?.name ?? '未分类') : '未分类'

  const filterLabel =
    folderId === 'all' ? '全部笔记' : folderId === 'none' ? '未分类' : folderName(folderId)

  return (
    // 外壳给页面的容器是块级、高度随内容，h-full 在这里会落空，分隔线就只长到内容底部。
    // 这一页是满屏三栏（不是纵向滚动页），自己定高最省事，也不必去动所有页面共用的那层容器。
    <div className="flex h-screen min-h-0 overflow-hidden">
      {/* 左栏：分类与标签 */}
      <aside className="flex w-56 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line px-3 pt-10 pb-6">
        <div>
          {/* 左栏所有文字都对齐到同一条竖线：分类项带展开箭头，标题和无箭头的项要跟着让出这段 */}
          <div className="mb-1.5 flex items-center justify-between pr-1 pl-6">
            <span className="text-[11px] font-medium tracking-wide text-slate-400">分类</span>
            <button
              className="rounded px-1 text-sm text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title="新建分类"
              onClick={() => startCreate(null)}
            >
              ＋
            </button>
          </div>
          <ul className="space-y-0.5">
            <li>
              <button
                className={`flex w-full items-center gap-1 rounded-lg py-1.5 pr-2 pl-1 text-left text-sm transition-colors ${
                  folderId === 'all'
                    ? 'bg-brand-soft font-medium text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                onClick={() => setFolderId('all')}
              >
                <span className="w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">全部笔记</span>
                {notes.length > 0 && (
                  <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">
                    {notes.length}
                  </span>
                )}
              </button>
            </li>
            <li>
              <button
                className={`flex w-full items-center gap-1 rounded-lg py-1.5 pr-2 pl-1 text-left text-sm transition-colors ${
                  folderId === 'none'
                    ? 'bg-brand-soft font-medium text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                onClick={() => setFolderId('none')}
              >
                <span className="w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">未分类</span>
              </button>
            </li>
            {tree.map((n) => (
              <FolderRow
                key={n.id}
                node={n}
                depth={0}
                active={folderId}
                expanded={expanded}
                draft={draft}
                onToggle={toggleExpand}
                onSelect={setFolderId}
                onMenu={folderMenu}
                onDraftChange={(v) => setDraft((d) => (d ? { ...d, value: v } : d))}
                onDraftCommit={() => void commitDraft()}
                onDraftCancel={() => setDraft(null)}
              />
            ))}
            {draft && !draft.id && !draft.parentId && (
              <FolderInput
                value={draft.value}
                depth={0}
                onChange={(v) => setDraft((d) => (d ? { ...d, value: v } : d))}
                onCommit={() => void commitDraft()}
                onCancel={() => setDraft(null)}
              />
            )}
          </ul>
          {tree.length === 0 && !draft && (
            <p className="pt-2 pr-2 pl-6 text-[11px] leading-5 text-slate-400">
              还没有分类。右键分类项可以改名、删除或加子分类。
            </p>
          )}
        </div>

        {tags.length > 0 && (
          <div>
            <div className="mb-1.5 pr-2 pl-6 text-[11px] font-medium tracking-wide text-slate-400">
              标签
            </div>
            <div className="flex flex-wrap gap-1.5 pr-2 pl-6">
              {tags.map((t) => (
                <button
                  key={t.tag}
                  onClick={() => setTag(tag === t.tag ? null : t.tag)}
                  className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
                    tag === t.tag
                      ? 'bg-brand text-white'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {t.tag}
                  <span className="ml-1 opacity-60 tabular-nums">{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* 中栏：笔记列表 */}
      <section className="flex w-80 shrink-0 flex-col border-r border-line">
        <div className="shrink-0 px-4 pt-10 pb-3">
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题、正文或标签"
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs outline-none transition-colors focus:border-brand"
            />
            <button
              className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
              onClick={() => void createNote()}
            >
              新建
            </button>
            <button
              className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title="记事本设置"
              aria-label="记事本设置"
              onClick={() => setSettingsOpen(true)}
            >
              设置
            </button>
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 px-0.5 text-[11px] text-slate-400">
            <span className="truncate">{filterLabel}</span>
            {tag && (
              <button
                className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 hover:text-slate-700"
                onClick={() => setTag(null)}
                title="清除标签筛选"
              >
                {tag} ✕
              </button>
            )}
            <span className="ml-auto shrink-0 tabular-nums">{visible.length}</span>
          </div>
        </div>

        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {visible.length === 0 && (
            <li className="px-2 py-10 text-center text-xs leading-6 whitespace-pre-line text-slate-400">
              {notes.length ? '没有符合条件的笔记' : '还没有笔记\n点「新建」写第一篇'}
            </li>
          )}
          {visible.map((n) => (
            <li key={n.id}>
              <div
                onClick={() => void open(n.id)}
                onContextMenu={(e) => noteMenu(e, n)}
                className={`cursor-default rounded-xl px-3 py-2.5 transition-colors ${
                  active?.id === n.id ? 'bg-brand-soft' : 'hover:bg-slate-100'
                }`}
              >
                <div className="flex items-baseline gap-1.5">
                  {n.pinned && <span className="shrink-0 text-[10px] text-brand">●</span>}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
                    {n.title}
                  </span>
                </div>
                {n.excerpt && (
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
                    {n.excerpt}
                  </div>
                )}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span
                    className="shrink-0 text-[10px] text-slate-400 tabular-nums"
                    title={prefs.timeField === 'created' ? '创建时间' : '最后修改'}
                  >
                    {noteTimeOf(n, prefs).slice(5, 16).replace('T', ' ')}
                  </span>
                  {n.tags.slice(0, 2).map((t) => (
                    <span
                      key={t}
                      className="truncate rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500"
                    >
                      {t}
                    </span>
                  ))}
                  {n.tags.length > 2 && (
                    <span className="shrink-0 text-[10px] text-slate-300">
                      +{n.tags.length - 2}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 右栏：编辑器 */}
      <section className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <NoteEditor
            key={active.id}
            note={active}
            folderLabel={folderName(active.folderId)}
            folders={folders}
            onChange={onEdit}
            onMove={(target) => void moveNote(active.id, target === 'none' ? null : target)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-slate-400">
            <span>选一篇笔记，或者新建一篇</span>
            <span className="text-xs text-slate-300">正文支持 Markdown，选中文字会浮出工具栏</span>
          </div>
        )}
      </section>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}

      {settingsOpen && (
        <NotebookSettings
          onClose={() => {
            setSettingsOpen(false)
            void reload() // 时间口径可能变了，列表要跟着换
          }}
        />
      )}
    </div>
  )
}
