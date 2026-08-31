// 笔记编辑器：所见即所得，磁盘上存的是 Markdown。
//
// 编辑区是非受控的 contentEditable——只在切换笔记时灌一次 innerHTML，之后完全交给 DOM，
// React 绝不再渲染它的子节点，否则每次按键都会和光标打架。
// 选中一段会在选区上方浮出工具栏；行首打 / 出插入菜单。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NoteFolder, NoteRecord } from '@shared/notebook'
import {
  applyInlineFormat,
  clearColorWrapper,
  currentBlock,
  editorSelectionRange,
  floatingBarPosition,
  placeCaret,
  type InlineFormat
} from './commands'
import { commitHistory, createHistory, resetHistory, stepHistory } from './history'
import { COLOR_LABELS, NOTE_COLORS, editorMarkdown, renderNoteHTML, type NoteColor } from './markdown'

interface Props {
  note: NoteRecord
  folderLabel: string
  folders: NoteFolder[]
  onChange: (patch: { title?: string; content?: string; tags?: string[] }) => void
  onMove: (folderId: string) => void
}

const ACTIONS: { kind: InlineFormat; label: string; title: string }[] = [
  { kind: 'bold', label: 'B', title: '加粗（⌘B）' },
  { kind: 'italic', label: 'I', title: '斜体（⌘I）' },
  { kind: 'strike', label: 'S', title: '删除线' },
  { kind: 'code', label: '</>', title: '行内代码' },
  { kind: 'link', label: '链接', title: '添加链接' }
]

type SlashId = 'h1' | 'h2' | 'h3' | 'todo' | 'ul' | 'ol' | 'quote' | 'code' | 'divider'

const SLASH_ITEMS: { id: SlashId; icon: string; label: string; keys: string }[] = [
  { id: 'h1', icon: 'H1', label: '一级标题', keys: 'h1 标题 title' },
  { id: 'h2', icon: 'H2', label: '二级标题', keys: 'h2 标题' },
  { id: 'h3', icon: 'H3', label: '三级标题', keys: 'h3 标题' },
  { id: 'todo', icon: '☑', label: '待办事项', keys: 'todo 待办 清单 task' },
  { id: 'ul', icon: '•', label: '项目列表', keys: 'ul 列表 bullet' },
  { id: 'ol', icon: '1.', label: '编号列表', keys: 'ol 编号 列表 number' },
  { id: 'quote', icon: '❝', label: '引用', keys: 'quote 引用' },
  { id: 'code', icon: '{ }', label: '代码块', keys: 'code 代码' },
  { id: 'divider', icon: '—', label: '分隔线', keys: 'divider 分隔 hr' }
]

export default function NoteEditor({
  note,
  folderLabel,
  folders,
  onChange,
  onMove
}: Props): React.JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const history = useRef(createHistory())
  const [bar, setBar] = useState<{ top: number; left: number } | null>(null)
  const [palette, setPalette] = useState<'mark' | 'color' | null>(null)
  const [linkDraft, setLinkDraft] = useState<string | null>(null)
  const [slash, setSlash] = useState<{ top: number; left: number; query: string; at: number } | null>(
    null
  )
  const [slashIndex, setSlashIndex] = useState(0)
  const [tagInput, setTagInput] = useState('')
  const [empty, setEmpty] = useState(false)

  // 载入这一篇。renderNoteHTML 的输出是白名单产物——整段先转义，只有颜色标签被解回来，
  // 所以这里的 innerHTML 不构成注入面。
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.innerHTML = renderNoteHTML(note.content)
    resetHistory(history.current, editor)
    setEmpty(!note.content.trim())
    // 只在切换笔记时重灌；正文后续变化由 DOM 自己持有
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])

  const syncBar = useCallback((): void => {
    const editor = editorRef.current
    const barEl = barRef.current
    if (!editor || !barEl) return
    const range = editorSelectionRange(editor)
    if (!range) {
      setBar(null)
      setPalette(null)
      return
    }
    setBar(
      floatingBarPosition(
        range,
        { width: barEl.offsetWidth, height: barEl.offsetHeight },
        editor.getBoundingClientRect().top
      )
    )
  }, [])

  // 选区没有专门的事件，只能盯 selectionchange；在工具栏里操作时不要跟着重算
  useEffect(() => {
    const onSelect = (): void => {
      if (document.activeElement?.closest('[data-note-bar]')) return
      syncBar()
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [syncBar])

  const pushChange = useCallback((): void => {
    const editor = editorRef.current
    if (!editor) return
    setEmpty(!editor.textContent?.trim())
    onChange({ content: editorMarkdown(editor) })
  }, [onChange])

  const runFormat = (kind: InlineFormat, value = ''): void => {
    const editor = editorRef.current
    if (kind === 'link') {
      setLinkDraft('https://')
      return
    }
    applyInlineFormat(editor, kind, value)
    setPalette(null)
    pushChange()
    commitHistory(history.current, editor, true)
    syncBar()
  }

  const pickColor = (kind: 'mark' | 'color', token: NoteColor | 'none'): void => {
    const editor = editorRef.current
    if (token === 'none') {
      clearColorWrapper(editor, kind)
      setPalette(null)
      pushChange()
      commitHistory(history.current, editor, true)
      return
    }
    runFormat(kind, token)
  }

  const confirmLink = (): void => {
    const href = (linkDraft ?? '').trim()
    setLinkDraft(null)
    if (!/^https?:\/\//i.test(href)) return
    const editor = editorRef.current
    applyInlineFormat(editor, 'link', '', () => href)
    pushChange()
    commitHistory(history.current, editor, true)
  }

  /** slash 菜单：把光标所在的整块换成目标块型。 */
  const applySlash = (id: SlashId): void => {
    const editor = editorRef.current
    const block = currentBlock(editor)
    if (!editor || !block || !slash) return
    // 先把触发用的 "/query" 从文本里抹掉
    const text = block.textContent ?? ''
    const cleaned = text.slice(0, slash.at) + text.slice(slash.at + slash.query.length + 1)
    const make = (html: string): HTMLElement => {
      const wrap = document.createElement('div')
      wrap.innerHTML = html
      return wrap.firstElementChild as HTMLElement
    }
    const body = cleaned.trim()
    let node: HTMLElement
    if (id === 'h1' || id === 'h2' || id === 'h3') {
      node = make(`<${id}></${id}>`)
      node.textContent = body
    } else if (id === 'quote') {
      node = make('<blockquote></blockquote>')
      node.textContent = body
    } else if (id === 'code') {
      node = make('<pre><code></code></pre>')
      ;(node.firstElementChild as HTMLElement).textContent = body
    } else if (id === 'divider') {
      node = make('<hr>')
    } else if (id === 'todo') {
      node = make('<ul class="note-todo"><li data-checked="false"><input type="checkbox" contenteditable="false"></li></ul>')
      node.querySelector('li')?.append(body)
    } else {
      const tag = id === 'ol' ? 'ol' : 'ul'
      node = make(`<${tag}><li></li></${tag}>`)
      const li = node.querySelector('li')
      if (li) li.textContent = body
    }
    block.replaceWith(node)
    // 代码块和分隔线后面要留一个空段落，否则光标无处可去
    if (id === 'code' || id === 'divider') {
      const tail = make('<p><br></p>')
      node.after(tail)
      placeCaret(tail)
    } else {
      placeCaret(node.querySelector('li') ?? node)
    }
    setSlash(null)
    editor.focus()
    pushChange()
    commitHistory(history.current, editor, true)
  }

  /** 行首或空白后打 / 才算触发，正文里的网址不会误弹菜单。 */
  const detectSlash = (): void => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount) return setSlash(null)
    const range = selection.getRangeAt(0)
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return setSlash(null)
    const before = (range.startContainer.nodeValue ?? '').slice(0, range.startOffset)
    const match = /(?:^|\s)\/([^\s/]*)$/.exec(before)
    if (!match) return setSlash(null)
    const rect = range.getBoundingClientRect()
    setSlashIndex(0)
    setSlash({
      top: rect.bottom + 6,
      left: rect.left,
      query: match[1],
      at: range.startOffset - match[1].length - 1
    })
  }

  const matched = slash
    ? SLASH_ITEMS.filter(
        (i) =>
          !slash.query ||
          i.label.includes(slash.query) ||
          i.keys.toLowerCase().includes(slash.query.toLowerCase())
      )
    : []

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const editor = editorRef.current
    if (slash && matched.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % matched.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + matched.length) % matched.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applySlash(matched[slashIndex].id)
        return
      }
      if (e.key === 'Escape') {
        setSlash(null)
        return
      }
    }
    if (e.key === 'Escape') {
      setBar(null)
      setPalette(null)
      return
    }
    if (!(e.metaKey || e.ctrlKey)) return
    const key = e.key.toLowerCase()
    if (key === 'z') {
      e.preventDefault()
      if (stepHistory(history.current, editor, e.shiftKey ? 1 : -1)) pushChange()
      return
    }
    if (key === 'y') {
      e.preventDefault()
      if (stepHistory(history.current, editor, 1)) pushChange()
      return
    }
    if (key === 'b' || key === 'i') {
      e.preventDefault()
      runFormat(key === 'b' ? 'bold' : 'italic')
    }
  }

  // Electron 的编辑菜单和触控板手势会发 historyUndo，同样要走自己的栈
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const onBefore = (e: Event): void => {
      const type = (e as InputEvent).inputType
      if (type !== 'historyUndo' && type !== 'historyRedo') return
      e.preventDefault()
      if (stepHistory(history.current, editor, type === 'historyUndo' ? -1 : 1)) pushChange()
    }
    editor.addEventListener('beforeinput', onBefore)
    return () => editor.removeEventListener('beforeinput', onBefore)
  }, [pushChange])

  /** 只收纯文本：外部 HTML 进不来，白名单模型才成立。 */
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    const selection = window.getSelection()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const lines = text.split(/\r?\n/)
    const frag = document.createDocumentFragment()
    lines.forEach((line, i) => {
      if (i) frag.appendChild(document.createElement('br'))
      frag.appendChild(document.createTextNode(line))
    })
    range.insertNode(frag)
    range.collapse(false)
    pushChange()
    commitHistory(history.current, editorRef.current, true)
  }

  const addTag = (): void => {
    const t = tagInput.trim()
    setTagInput('')
    if (!t || note.tags.includes(t)) return
    onChange({ tags: [...note.tags, t] })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 标题、标签、正文共用一条列宽：满宽的行在大屏上太长，读着费劲 */}
      <header className="mx-auto w-full max-w-3xl shrink-0 px-8 pt-10 pb-3">
        <input
          value={note.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="标题"
          className="w-full border-none bg-transparent text-lg font-semibold outline-none placeholder:text-slate-300"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <select
            value={note.folderId ?? 'none'}
            onChange={(e) => onMove(e.target.value)}
            className="rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 outline-none"
            title={`当前分类：${folderLabel}`}
          >
            <option value="none">未分类</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {note.tags.map((t) => (
            <span
              key={t}
              className="group flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-slate-500"
            >
              {t}
              <button
                className="text-slate-300 group-hover:text-red-500"
                onClick={() => onChange({ tags: note.tags.filter((x) => x !== t) })}
                aria-label={`移除标签 ${t}`}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTag()
            }}
            onBlur={addTag}
            placeholder="加标签"
            className="w-16 border-none bg-transparent outline-none placeholder:text-slate-300"
          />
        </div>
      </header>

      {/* 正文比标题窄一列，但点空白处也该落到光标上，所以外层整片都可点 */}
      <div
        className="relative min-h-0 flex-1 overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) editorRef.current?.focus()
        }}
      >
        {empty && (
          <div className="pointer-events-none absolute inset-x-0 px-8 py-4">
            <div className="mx-auto max-w-3xl text-sm text-slate-300">
              写点什么。选中一段会浮出工具栏，行首打 / 插入标题、列表或代码块。
            </div>
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="笔记正文"
          spellCheck
          className="note-body mx-auto min-h-full max-w-3xl px-8 py-4 text-sm leading-7 outline-none"
          onInput={() => {
            pushChange()
            commitHistory(history.current, editorRef.current)
            detectSlash()
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>

      {/* 气泡工具栏常驻但不可见，这样随时能量到宽高来定位 */}
      <div
        ref={barRef}
        data-note-bar
        className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-slate-200 bg-surface px-1 py-1 shadow-lg"
        style={{
          top: bar?.top ?? -9999,
          left: bar?.left ?? -9999,
          visibility: bar ? 'visible' : 'hidden'
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {linkDraft === null ? (
          <>
            {ACTIONS.map((a) => (
              <button
                key={a.kind}
                title={a.title}
                onClick={() => runFormat(a.kind)}
                className="rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
              >
                {a.label}
              </button>
            ))}
            <span className="mx-0.5 h-3.5 w-px bg-slate-200" />
            <button
              title="文字颜色"
              onClick={() => setPalette((p) => (p === 'color' ? null : 'color'))}
              className="rounded px-1.5 py-0.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              A
            </button>
            <button
              title="高亮"
              onClick={() => setPalette((p) => (p === 'mark' ? null : 'mark'))}
              className="rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              ▰
            </button>
            <span className="mx-0.5 h-3.5 w-px bg-slate-200" />
            <button
              title="清除格式"
              onClick={() => runFormat('clear')}
              className="rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              ⌫
            </button>
            {palette && (
              <div className="absolute top-full left-0 mt-1 flex gap-1 rounded-lg border border-slate-200 bg-surface p-1.5 shadow-lg">
                {NOTE_COLORS.map((c) => (
                  <button
                    key={c}
                    title={COLOR_LABELS[c]}
                    aria-label={COLOR_LABELS[c]}
                    onClick={() => pickColor(palette, c)}
                    className={`size-4 rounded-full border border-black/10 ${
                      palette === 'mark' ? `note-swatch-mark-${c}` : `note-swatch-${c}`
                    }`}
                  />
                ))}
                <button
                  title="清除"
                  onClick={() => pickColor(palette, 'none')}
                  className="px-1 text-xs text-slate-400 hover:text-slate-700"
                >
                  ⌫
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <input
              autoFocus
              value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmLink()
                if (e.key === 'Escape') setLinkDraft(null)
              }}
              placeholder="https://"
              className="w-48 rounded border border-slate-200 px-1.5 py-0.5 text-xs outline-none"
            />
            <button
              onClick={confirmLink}
              className="rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              确定
            </button>
          </>
        )}
      </div>

      {slash && matched.length > 0 && (
        <div
          className="fixed z-50 w-44 rounded-lg border border-slate-200 bg-surface py-1 shadow-lg"
          style={{ top: slash.top, left: slash.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {matched.map((item, i) => (
            <button
              key={item.id}
              onClick={() => applySlash(item.id)}
              onMouseEnter={() => setSlashIndex(i)}
              className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs ${
                i === slashIndex ? 'bg-slate-100 text-slate-900' : 'text-slate-600'
              }`}
            >
              <span className="w-5 shrink-0 text-center text-slate-400">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
