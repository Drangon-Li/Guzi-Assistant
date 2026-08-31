// 记事本的设置：时间显示口径 + 哪些内容不给谷子看。
//
// 插件的配置放在插件自己这儿，不进核心设置页——停用插件不会在那边留下空分区，
// 用户找配置也不用先判断这是核心功能还是插件功能。
import { useEffect, useState } from 'react'
import {
  buildFolderTree,
  sortNotes,
  UNFILED,
  visibleToAssistant,
  type FolderNode,
  type NoteFolder,
  type NotebookPrefs,
  type NoteSummary
} from '@shared/notebook'
import { api } from '../../api'
import Modal from '../../components/Modal'
import { Segmented, Toggle } from '../../components/ui'

const call = <T,>(action: string, ...args: unknown[]): Promise<T> =>
  api.plugin<T>('notebook', action, ...args)

function FolderToggle({
  node,
  depth,
  hidden,
  onToggle
}: {
  node: FolderNode
  depth: number
  hidden: string[]
  onToggle: (id: string, next: boolean) => void
}): React.JSX.Element {
  const off = hidden.includes(node.id)
  return (
    <>
      <li
        className="flex items-center justify-between gap-3 py-1.5"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <span className={`min-w-0 flex-1 truncate text-sm ${off ? 'text-slate-400' : 'text-slate-600'}`}>
          {node.name}
          {node.noteCount > 0 && (
            <span className="ml-1.5 text-[10px] text-slate-400 tabular-nums">{node.noteCount}</span>
          )}
        </span>
        <Toggle
          checked={!off}
          ariaLabel={`${off ? '让' : '不让'}谷子看到分类 ${node.name}`}
          onChange={(next) => onToggle(node.id, !next)}
        />
      </li>
      {node.children.map((c) => (
        <FolderToggle key={c.id} node={c} depth={depth + 1} hidden={hidden} onToggle={onToggle} />
      ))}
    </>
  )
}

export default function NotebookSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [prefs, setPrefs] = useState<NotebookPrefs | null>(null)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>([])

  useEffect(() => {
    void Promise.all([
      call<NotebookPrefs>('prefs'),
      call<NoteSummary[]>('list'),
      call<NoteFolder[]>('folders')
    ]).then(([p, n, f]) => {
      setPrefs(p)
      setNotes(n)
      setFolders(f)
    })
  }, [])

  const patch = (next: Partial<NotebookPrefs>): void => {
    setPrefs((p) => (p ? { ...p, ...next } : p))
    void call<NotebookPrefs>('set-prefs', next).then(setPrefs)
  }

  const toggleFolder = (id: string, off: boolean): void => {
    if (!prefs) return
    patch({
      hiddenFolders: off
        ? [...prefs.hiddenFolders, id]
        : prefs.hiddenFolders.filter((x) => x !== id)
    })
  }

  const tree = prefs ? buildFolderTree(folders, notes) : []
  // 分类整个关掉时，里面的笔记不必再逐条列——它们已经不在范围内了
  const perNote = prefs ? sortNotes(visibleToAssistant(notes, folders, { ...prefs, hiddenNotes: [] })) : []

  return (
    <Modal
      panelClass="flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl"
      onClose={onClose}
    >
      {(close) => (
        <>
          <header className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
            <div>
              <div className="text-base font-semibold">记事本设置</div>
              <div className="mt-0.5 text-xs text-slate-400">只影响这个插件，不改其他功能</div>
            </div>
            <button
              aria-label="关闭"
              className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              onClick={close}
            >
              ✕
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {!prefs ? (
              <div className="flex justify-center py-10">
                <div className="size-5 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" />
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <section>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">列表上显示的时间</div>
                      <p className="mt-0.5 text-xs text-slate-400">
                        想按写下的时间回溯就选创建时间，想知道最近动过哪篇就选修改时间。
                      </p>
                    </div>
                    <Segmented
                      value={prefs.timeField}
                      options={[
                        ['updated', '最后修改'],
                        ['created', '创建时间']
                      ]}
                      onChange={(v) => patch({ timeField: v })}
                    />
                  </div>
                </section>

                <section>
                  <div className="text-sm font-medium">谷子能看到哪些笔记</div>
                  <p className="mt-0.5 mb-3 text-xs leading-5 text-slate-400">
                    关掉的内容不会进对话上下文，问它也答不上来。谷子只拿到标题和一句摘要，
                    正文从不进提示词。
                  </p>

                  {tree.length > 0 && (
                    <div className="mb-4">
                      <div className="mb-1 text-[11px] font-medium text-slate-400">按分类</div>
                      <ul className="rounded-xl border border-line px-3 py-1">
                        <FolderToggle
                          node={{
                            id: UNFILED,
                            name: '未分类',
                            parentId: null,
                            sortOrder: -1,
                            createdAt: '',
                            children: [],
                            noteCount: notes.filter((n) => !n.folderId).length
                          }}
                          depth={0}
                          hidden={prefs.hiddenFolders}
                          onToggle={toggleFolder}
                        />
                        {tree.map((n) => (
                          <FolderToggle
                            key={n.id}
                            node={n}
                            depth={0}
                            hidden={prefs.hiddenFolders}
                            onToggle={toggleFolder}
                          />
                        ))}
                      </ul>
                      <p className="mt-1 text-[11px] text-slate-400">
                        关掉一个分类，它下面的子分类也一起不给看。
                      </p>
                    </div>
                  )}

                  <div>
                    <div className="mb-1 text-[11px] font-medium text-slate-400">按单篇</div>
                    {perNote.length === 0 ? (
                      <p className="rounded-xl border border-line px-3 py-4 text-center text-xs text-slate-400">
                        {notes.length ? '这些笔记所在的分类已经整个关掉了' : '还没有笔记'}
                      </p>
                    ) : (
                      <ul className="max-h-56 overflow-y-auto rounded-xl border border-line px-3 py-1">
                        {perNote.map((n) => {
                          const off = prefs.hiddenNotes.includes(n.id)
                          return (
                            <li key={n.id} className="flex items-center justify-between gap-3 py-1.5">
                              <span
                                className={`min-w-0 flex-1 truncate text-sm ${
                                  off ? 'text-slate-400' : 'text-slate-600'
                                }`}
                              >
                                {n.title}
                              </span>
                              <Toggle
                                checked={!off}
                                ariaLabel={`${off ? '让' : '不让'}谷子看到笔记 ${n.title}`}
                                onChange={(next) =>
                                  patch({
                                    hiddenNotes: next
                                      ? prefs.hiddenNotes.filter((x) => x !== n.id)
                                      : [...prefs.hiddenNotes, n.id]
                                  })
                                }
                              />
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
