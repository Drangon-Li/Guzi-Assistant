// 笔记编辑器：所见即所得，磁盘上存的是 Markdown。
//
// 编辑区是非受控的 contentEditable——只在切换笔记时灌一次 innerHTML，之后完全交给 DOM，
// React 绝不再渲染它的子节点，否则每次按键都会和光标打架。
// 选中一段会在选区上方浮出工具栏；行首打 / 出插入菜单。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NoteFolder, NoteRecord } from '@shared/notebook'
import { api } from '../../api'
import ContextMenu, { type MenuEntry } from '../../components/ContextMenu'
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
import {
  COLOR_LABELS,
  NOTE_COLORS,
  editorMarkdown,
  collectHeadings,
  markdownBlockRule,
  mathSourceRe,
  renderMath,
  renderNoteHTML,
  type BlockKind,
  type NoteColor,
  type NoteHeading
} from './markdown'

interface Props {
  note: NoteRecord
  folderLabel: string
  folders: NoteFolder[]
  /** 正文字号倍率（⌘+/⌘- 调）。CSS 里标题、代码的字号都是 em，跟着根字号一起缩放 */
  fontScale: number
  /** 沉浸模式下连目录一起收起——那个模式的意思就是「只留正文」 */
  immersive: boolean
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

const call = <T,>(action: string, ...args: unknown[]): Promise<T> =>
  api.plugin<T>('notebook', action, ...args)

const readAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

type SlashId = BlockKind

const SLASH_ITEMS: { id: SlashId; icon: string; label: string; keys: string }[] = [
  { id: 'h1', icon: 'H1', label: '一级标题', keys: 'h1 标题 title' },
  { id: 'h2', icon: 'H2', label: '二级标题', keys: 'h2 标题' },
  { id: 'h3', icon: 'H3', label: '三级标题', keys: 'h3 标题' },
  { id: 'todo', icon: '☑', label: '待办事项', keys: 'todo 待办 清单 task' },
  { id: 'ul', icon: '•', label: '项目列表', keys: 'ul 列表 bullet' },
  { id: 'ol', icon: '1.', label: '编号列表', keys: 'ol 编号 列表 number' },
  { id: 'quote', icon: '❝', label: '引用', keys: 'quote 引用' },
  { id: 'code', icon: '{ }', label: '代码块', keys: 'code 代码' },
  { id: 'divider', icon: '—', label: '分隔线', keys: 'divider 分隔 hr' },
  { id: 'math', icon: '∑', label: '数学公式', keys: 'math 公式 latex tex formula' }
]

/**
 * 把一个元素里还没渲染的 $…$ 就地换成公式节点。
 *
 * 只动文本节点，不重建整块——早先那版是「失焦时整篇 renderNoteHTML 重来一遍」，
 * 笔记一长就明显卡，而且非得失焦才出结果。现在按块渲染，离开当前块就出。
 * 放在组件外：纯 DOM 操作，不依赖任何 render 作用域里的东西。
 */
function renderMathIn(root: HTMLElement): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let cursor: Node | null
  while ((cursor = walker.nextNode())) {
    const text = cursor as Text
    const parent = text.parentElement
    // 已经渲染成公式的内部、以及代码块里的 $，都不是待渲染的源码
    if (parent?.closest('[data-tex]') || parent?.closest('pre')) continue
    if (mathSourceRe().test(text.nodeValue ?? '')) targets.push(text)
  }
  if (!targets.length) return false
  for (const text of targets) {
    const src = text.nodeValue ?? ''
    const frag = document.createDocumentFragment()
    const re = mathSourceRe()
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      if (m.index > last) frag.append(src.slice(last, m.index))
      const display = m[1] !== undefined
      const holder = document.createElement('div')
      holder.innerHTML = renderMath(display ? m[1] : m[2], display)
      const node = holder.firstElementChild
      if (node) frag.append(node)
      last = m.index + m[0].length
    }
    if (last < src.length) frag.append(src.slice(last))
    text.replaceWith(frag)
  }
  return true
}

export default function NoteEditor({
  note,
  folderLabel,
  folders,
  fontScale,
  immersive,
  onChange,
  onMove
}: Props): React.JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const history = useRef(createHistory())
  /** 光标上一次所在的块：换块时把旧块里的公式渲染出来 */
  const lastBlock = useRef<HTMLElement | null>(null)
  /** 渲染公式会改 DOM，可能再次触发 selectionchange，防重入 */
  const renderingMath = useRef(false)
  const [bar, setBar] = useState<{ top: number; left: number } | null>(null)
  const [palette, setPalette] = useState<'mark' | 'color' | null>(null)
  const [linkDraft, setLinkDraft] = useState<string | null>(null)
  const [slash, setSlash] = useState<{ top: number; left: number; query: string; at: number } | null>(
    null
  )
  const [slashIndex, setSlashIndex] = useState(0)
  const [tagInput, setTagInput] = useState('')
  const [empty, setEmpty] = useState(false)
  const [headings, setHeadings] = useState<NoteHeading[]>([])
  /** 目录里高亮哪一条（= 视口顶部往下最近的那个标题的下标） */
  const [activeHeading, setActiveHeading] = useState(-1)
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 始终指向最新的输入规则函数：beforeinput 的 effect 只订阅一次，不能捕获旧闭包 */
  const markdownRuleRef = useRef<() => boolean>(() => false)

  // 载入这一篇。renderNoteHTML 的输出是白名单产物——整段先转义，只有颜色标签被解回来，
  // 所以这里的 innerHTML 不构成注入面。
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.innerHTML = renderNoteHTML(note.content)
    hydrateImages()
    resetHistory(history.current, editor)
    setEmpty(!note.content.trim())
    setHeadings(collectHeadings(editor))
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

  const pushChange = useCallback((): void => {
    const editor = editorRef.current
    if (!editor) return
    // 有图片时不算空，否则只放了一张图的笔记会一直显示占位提示
    setEmpty(!editor.textContent?.trim() && !editor.querySelector('img[data-asset]'))
    setHeadings(collectHeadings(editor))
    onChange({ content: editorMarkdown(editor) })
  }, [onChange])

  const renderMathInBlock = useCallback(
    (block: HTMLElement | null): void => {
      const editor = editorRef.current
      if (!block || !editor || !editor.contains(block)) return
      if (!renderMathIn(block)) return
      pushChange()
      commitHistory(history.current, editor, true)
    },
    [pushChange]
  )

  // 选区没有专门的事件，只能盯 selectionchange；在工具栏里操作时不要跟着重算
  useEffect(() => {
    const onSelect = (): void => {
      if (document.activeElement?.closest('[data-note-bar]')) return
      if (!renderingMath.current) {
        const block = currentBlock(editorRef.current)
        const prev = lastBlock.current
        // 光标离开某一块 → 那块里新打的 $…$ 就地渲染。Notion/Obsidian 的手感：
        // 敲完回车立刻成型，而不是等整个编辑区失焦
        if (prev && prev !== block) {
          renderingMath.current = true
          try {
            renderMathInBlock(prev)
          } finally {
            renderingMath.current = false
          }
        }
        lastBlock.current = block
      }
      syncBar()
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [syncBar, renderMathInBlock])

  /** 点目录跳到对应标题。按下标现查而不是存 DOM 引用——正文一直在变，存引用容易拿到旧节点。 */
  const scrollToHeading = (index: number): void => {
    const el = editorRef.current?.querySelectorAll('h1, h2, h3')[index]
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 滚动时高亮当前小节：取「已经滚过视口顶部」的最后一个标题。
  // 用滚动事件而不是 IntersectionObserver——正文随时增删标题，观察器要跟着反复重挂，
  // 这里一次遍历几十个标题的开销远小于那套维护成本。
  useEffect(() => {
    const scroller = scrollRef.current
    const editor = editorRef.current
    if (!scroller || !editor) return
    const onScroll = (): void => {
      const top = scroller.getBoundingClientRect().top + 8
      let current = -1
      editor.querySelectorAll('h1, h2, h3').forEach((el, i) => {
        if (el.getBoundingClientRect().top <= top) current = i
      })
      setActiveHeading(current)
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [headings])

  /** 正文里的图片只存了文件名，挂载后逐个把 data URL 填进 src。 */
  const hydrateImages = useCallback((): void => {
    const imgs = editorRef.current?.querySelectorAll<HTMLImageElement>('img[data-asset]')
    imgs?.forEach((img) => {
      const id = img.dataset.asset
      if (!id || img.getAttribute('src')) return
      void call<string | null>('read-image', id).then((url) => {
        if (url) img.src = url
      })
    })
  }, [])

  const insertImages = useCallback(
    async (files: File[], at?: Range | null): Promise<void> => {
      const editor = editorRef.current
      if (!editor || !files.length) return
      let range = at
      for (const file of files) {
        const res = await call<{ ok: boolean; id?: string; message?: string }>('save-image', {
          dataUrl: await readAsDataURL(file)
        })
        if (!res?.ok || !res.id) {
          window.alert(res?.message ?? '这张图没能存下来')
          continue
        }
        const img = document.createElement('img')
        img.dataset.asset = res.id
        img.alt = file.name.replace(/\.[^.]+$/, '')
        if (range && editor.contains(range.commonAncestorContainer)) {
          range.deleteContents()
          range.insertNode(img)
          range.setStartAfter(img)
          range.collapse(true)
        } else {
          editor.append(img)
          range = null
        }
      }
      hydrateImages()
      pushChange()
      commitHistory(history.current, editor, true)
    },
    [hydrateImages, pushChange]
  )

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
  const make = (html: string): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.innerHTML = html
    return wrap.firstElementChild as HTMLElement
  }

  /** 把当前块换成目标块并落好光标。/ 菜单和 Markdown 输入规则共用。 */
  const convertBlock = (id: SlashId, block: HTMLElement, body: string): void => {
    const editor = editorRef.current
    if (!editor) return
    let node: HTMLElement
    // 空块必须留一个 <br>：contentEditable 里没有内容的块元素不是合法的落点，
    // 浏览器会把光标弹到上一行（打「# 」变标题时光标跳走就是这个原因）。
    const fill = (el: HTMLElement, text: string): void => {
      if (text) el.textContent = text
      else el.append(document.createElement('br'))
    }
    if (id === 'h1' || id === 'h2' || id === 'h3') {
      node = make(`<${id}></${id}>`)
      fill(node, body)
    } else if (id === 'quote') {
      node = make('<blockquote></blockquote>')
      fill(node, body)
    } else if (id === 'code') {
      node = make('<pre><code></code></pre>')
      ;(node.firstElementChild as HTMLElement).textContent = body
    } else if (id === 'divider') {
      node = make('<hr>')
    } else if (id === 'math') {
      // 公式先以源码形态插入，光标离开这一块时才渲染（见 renderMathInBlock）
      node = make('<p></p>')
      node.textContent = `$$${body}$$`
      block.replaceWith(node)
      const text = node.firstChild
      const selection = window.getSelection()
      if (text && selection) {
        const range = document.createRange()
        range.setStart(text, 2) // 落在两组 $$ 中间
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      editor.focus()
      pushChange()
      commitHistory(history.current, editor, true)
      return
    } else if (id === 'todo') {
      node = make('<ul class="note-todo"><li data-checked="false"><input type="checkbox" contenteditable="false"></li></ul>')
      const todoLi = node.querySelector('li')
      if (todoLi) {
        if (body) todoLi.append(body)
        else todoLi.append(document.createElement('br'))
      }
    } else {
      const tag = id === 'ol' ? 'ol' : 'ul'
      node = make(`<${tag}><li></li></${tag}>`)
      const li = node.querySelector('li')
      if (li) fill(li, body)
    }
    block.replaceWith(node)
    // 代码块和分隔线后面都要留一个空段落，否则块落在文末时光标出不来。
    // 但落点不同：分隔线（hr）存不住光标，只能落到后面那段；代码块要落在**里面**，
    // 否则打完 ``` 光标在代码块下方，代码根本敲不进去。
    if (id === 'code' || id === 'divider') {
      const tail = make('<p><br></p>')
      node.after(tail)
      placeCaret(id === 'code' ? (node.querySelector('code') ?? node) : tail)
    } else {
      const target = node.querySelector('li') ?? node
      // 只有 <br> 占位的空块要落在块首：落到「内容末尾」等于落到 <br> 之后，又跑到下一行去了
      placeCaret(target, !(target.childNodes.length === 1 && target.firstChild?.nodeName === 'BR'))
    }
    editor.focus()
    pushChange()
    commitHistory(history.current, editor, true)
  }

  const applySlash = (id: SlashId): void => {
    const block = currentBlock(editorRef.current)
    if (!block || !slash) return
    // 先把触发用的 "/query" 从文本里抹掉
    const text = block.textContent ?? ''
    const cleaned = text.slice(0, slash.at) + text.slice(slash.at + slash.query.length + 1)
    setSlash(null)
    convertBlock(id, block, cleaned.trim())
  }

  /**
   * Markdown 输入规则：块首打 `# `、`- `、`1. ` 这类前缀立刻变成对应的块。
   * 命中返回 true，调用方据此吃掉这次空格。
   */
  const applyMarkdownRule = (): boolean => {
    const editor = editorRef.current
    const block = currentBlock(editor)
    const selection = window.getSelection()
    if (!editor || !block || !selection?.rangeCount) return false
    const range = selection.getRangeAt(0)
    if (!range.collapsed) return false
    // 取块内光标之前的全部文字：markdownBlockRule 只认整段恰好等于前缀的情况
    const before = range.cloneRange()
    before.selectNodeContents(block)
    before.setEnd(range.endContainer, range.endOffset)
    const kind = markdownBlockRule(before.toString())
    if (!kind) return false
    // 前缀之后的内容留下来（在行首打前缀时通常为空，但用户也可能回头补前缀）
    const rest = (block.textContent ?? '').slice(before.toString().length)
    convertBlock(kind, block, rest.trim())
    return true
  }
  markdownRuleRef.current = applyMarkdownRule

  /** 点已渲染的公式 → 换回 $…$ 源码就地改；改完失焦再渲染回去。 */
  const openMathSource = (target: HTMLElement): boolean => {
    const math = target.closest<HTMLElement>('[data-tex]')
    const editor = editorRef.current
    if (!math || !editor || !editor.contains(math)) return false
    const tex = math.dataset.tex ?? ''
    const display = math.classList.contains('note-math')
    const src = display ? `$$${tex}$$` : `$${tex}$`
    let caretNode: Node
    if (display) {
      const p = make('<p></p>')
      p.textContent = src
      math.replaceWith(p)
      caretNode = p.firstChild ?? p
    } else {
      const text = document.createTextNode(src)
      math.replaceWith(text)
      caretNode = text
    }
    const selection = window.getSelection()
    if (selection && caretNode.nodeType === Node.TEXT_NODE) {
      const range = document.createRange()
      range.setStart(caretNode, Math.max(0, (caretNode.nodeValue ?? '').length - (display ? 2 : 1)))
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    editor.focus()
    pushChange()
    return true
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
    // 中文输入法选字期间，方向键/回车/空格都归输入法，不能当快捷键截走
    if (e.nativeEvent.isComposing) return
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
      const evt = e as InputEvent
      const type = evt.inputType
      // Markdown 输入规则挂在 beforeinput 而不是 keydown：中文输入法激活时，
      // keydown 上报的 key 未必是 ' '（常见是 Process / keyCode 229），
      // 结果就是打「## 」只留下字面量。beforeinput 的 inputType+data 不受输入法影响。
      // 组合输入期间是 insertCompositionText，这里天然不会命中。
      if (type === 'insertText' && evt.data === ' ') {
        if (markdownRuleRef.current()) e.preventDefault()
        return
      }
      if (type !== 'historyUndo' && type !== 'historyRedo') return
      e.preventDefault()
      if (stepHistory(history.current, editor, type === 'historyUndo' ? -1 : 1)) pushChange()
    }
    editor.addEventListener('beforeinput', onBefore)
    return () => editor.removeEventListener('beforeinput', onBefore)
  }, [pushChange])

  const imageFiles = (list: FileList | null | undefined): File[] =>
    [...(list ?? [])].filter((f) => f.type.startsWith('image/'))

  /**
   * 图片拖进正文就插到落点，不走「拖文件进来解析成日程」那条全局管线。
   * 只 preventDefault、不拦冒泡：外层要靠这次事件把「松开以提交文件」的蒙版收掉，
   * 它看到 defaultPrevented 就知道里层已经接手，不会重复提交。
   * 拖别的东西（比如 PDF）照旧交给外层。
   */
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const files = imageFiles(e.dataTransfer?.files)
    if (!files.length) return
    e.preventDefault()
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null
    void insertImages(files, at)
  }

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (![...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) return
    e.preventDefault()
  }

  /** 图片存下来插进正文；其余只收纯文本——外部 HTML 进不来，白名单模型才成立。 */
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>): void => {
    const pics = imageFiles(e.clipboardData?.files)
    if (pics.length) {
      e.preventDefault()
      const selection = window.getSelection()
      void insertImages(pics, selection?.rangeCount ? selection.getRangeAt(0) : null)
      return
    }
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

  /** 在光标处插入行内公式骨架 $|$，光标落在两个 $ 中间，直接打 TeX 即可。 */
  const insertInlineMath = (): void => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.commonAncestorContainer)) return
    range.deleteContents()
    const text = document.createTextNode('$$')
    range.insertNode(text)
    const next = document.createRange()
    next.setStart(text, 1)
    next.collapse(true)
    selection.removeAllRanges()
    selection.addRange(next)
    editor.focus()
    pushChange()
    commitHistory(history.current, editor, true)
  }

  /** 右键菜单：把 / 菜单里那些块型摆到手边，再加上行内公式和选中文字的行内格式。 */
  const openContextMenu = (e: React.MouseEvent): void => {
    const editor = editorRef.current
    if (!editor) return
    const selection = window.getSelection()
    const hasSelection = !!selection && !selection.isCollapsed && !!selection.toString().trim()
    // 右键不保证移动光标（macOS 上通常不动），所以没有选区时先把光标落到点击处——
    // 否则 currentBlock 拿到的是上一次的位置，甚至是 null，菜单点了像没反应。
    if (!hasSelection && selection) {
      const at = document.caretRangeFromPoint?.(e.clientX, e.clientY)
      if (at && editor.contains(at.commonAncestorContainer)) {
        selection.removeAllRanges()
        selection.addRange(at)
      }
    }
    const block = currentBlock(editor)
    // 右键菜单一出来，选区上方那条浮动工具栏就该让位，两层浮层叠在一起很乱
    setBar(null)
    setPalette(null)
    // 右键在已渲染的公式上 → 直接给「编辑这条公式」，比让用户猜要点一下强
    const mathTarget = (e.target as HTMLElement).closest<HTMLElement>('[data-tex]')
    const asBlock = (id: SlashId) => () => {
      if (block) convertBlock(id, block, (block.textContent ?? '').trim())
    }
    const entries: MenuEntry[] = []
    if (mathTarget) {
      entries.push(
        { label: '编辑这条公式', onClick: () => openMathSource(mathTarget) },
        { type: 'separator' }
      )
    }
    if (hasSelection) {
      entries.push(
        { type: 'header', label: '选中文字' },
        { label: '加粗', onClick: () => runFormat('bold') },
        { label: '斜体', onClick: () => runFormat('italic') },
        { label: '行内代码', onClick: () => runFormat('code') },
        { label: '删除线', onClick: () => runFormat('strike') },
        { type: 'separator' }
      )
    }
    entries.push(
      { type: 'header', label: '插入' },
      { label: '行内公式  $…$', onClick: insertInlineMath },
      { label: '行间公式  $$…$$', onClick: asBlock('math') },
      { label: '代码块', onClick: asBlock('code') },
      { label: '分隔线', onClick: asBlock('divider') },
      { type: 'separator' },
      { type: 'header', label: '当前段落' },
      { label: '一级标题', onClick: asBlock('h1') },
      { label: '二级标题', onClick: asBlock('h2') },
      { label: '三级标题', onClick: asBlock('h3') },
      { label: '项目列表', onClick: asBlock('ul') },
      { label: '编号列表', onClick: asBlock('ol') },
      { label: '待办事项', onClick: asBlock('todo') },
      { label: '引用', onClick: asBlock('quote') }
    )
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, entries })
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

      <div className="relative flex min-h-0 flex-1">
      {/* 正文比标题窄一列，但点空白处也该落到光标上，所以外层整片都可点 */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) editorRef.current?.focus()
        }}
      >
        {empty && (
          <div className="pointer-events-none absolute inset-x-0 px-8 py-4">
            <div className="mx-auto max-w-3xl text-sm text-slate-300">
              写点什么。选中一段会浮出工具栏，行首打 / 插入标题、列表或代码块，图片可以直接拖进来。
            </div>
          </div>
        )}
        {/* 字号只设在正文这一层：CSS 里标题、代码、行内码的 font-size 全是 em，会等比跟随。
            用 style 而不是 Tailwind 的 text-sm——固定值会盖掉倍率。 */}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="笔记正文"
          spellCheck
          style={{ fontSize: `${(14 * fontScale).toFixed(1)}px` }}
          className="note-body mx-auto min-h-full max-w-3xl px-8 py-4 leading-7 outline-none"
          onInput={() => {
            pushChange()
            commitHistory(history.current, editorRef.current)
            detectSlash()
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onClick={(e) => {
            if (openMathSource(e.target as HTMLElement)) e.preventDefault()
          }}
          onContextMenu={openContextMenu}
          onBlur={(e) => {
            // 点浮动工具栏也会让编辑区失焦，那时候不能重排——会把用户的选区弄丢
            if ((e.relatedTarget as HTMLElement | null)?.closest('[data-note-bar]')) return
            // 整个编辑区失焦时，最后停留的那一块不会再触发「块变化」，这里兜一次
            renderMathInBlock(lastBlock.current)
            lastBlock.current = null
          }}
        />
      </div>

      {/* 右侧目录：Notion 那种「右边距几条短横线，悬停展开」的做法。
          做成绝对定位的浮层而不是一列，是因为这一栏本来就窄——三栏侧边栏都展开时
          正文只剩三百多像素，再切一条目录列，正文就没法读了。
          标题够两条才出现：一条标题的目录没有存在意义。 */}
      {!immersive && headings.length > 1 && (
        <div className="group/toc absolute top-3 right-2 z-10">
          <div className="flex flex-col items-end gap-1.5 py-2 transition-opacity group-hover/toc:opacity-0">
            {headings.map((h) => (
              <span
                key={`dash-${h.index}`}
                className={`block h-0.5 rounded-full transition-colors ${
                  activeHeading === h.index ? 'bg-slate-500' : 'bg-slate-300'
                }`}
                style={{ width: `${18 - (h.level - 1) * 4}px` }}
              />
            ))}
          </div>
          <nav className="pointer-events-none absolute top-0 right-0 max-h-[70vh] w-48 overflow-y-auto rounded-lg border border-line bg-surface p-1.5 opacity-0 shadow-lg transition-opacity group-hover/toc:pointer-events-auto group-hover/toc:opacity-100">
            {headings.map((h) => (
              <button
                key={`row-${h.index}`}
                className={`block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors hover:bg-slate-100 hover:text-slate-700 ${
                  activeHeading === h.index ? 'bg-slate-100 font-medium text-slate-700' : 'text-slate-400'
                }`}
                style={{ paddingLeft: `${0.5 + (h.level - 1) * 0.75}rem` }}
                title={h.text}
                onClick={() => scrollToHeading(h.index)}
              >
                {h.text}
              </button>
            ))}
          </nav>
        </div>
      )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}

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
