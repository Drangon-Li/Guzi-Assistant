// 选区上的行内格式命令。
//
// 跨段落的选区不能直接 surroundContents——那会产出 <mark><p>…</p></mark> 这种非法嵌套，
// 或者直接抛异常。做法是把选区触及的每一段文本单独包一次，块结构原样不动。
// 这段算法照搬谷子学术阅读笔记，是整套编辑器里最难自己写对的部分。
import { colorToken, type NoteColor } from './markdown.ts'

interface Slice {
  node: Text
  start: number
  end: number
}

export function editorSelectionRange(editor: HTMLElement | null): Range | null {
  const selection = window.getSelection()
  if (!editor || !selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (range.collapsed || !editor.contains(range.commonAncestorContainer)) return null
  return range
}

function rangeSlices(editor: HTMLElement, range: Range): Slice[] {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null)
  const slices: Slice[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.nodeValue || !range.intersectsNode(node)) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.nodeValue.length
    if (end > start) slices.push({ node, start, end })
  }
  return slices
}

function unwrap(element: Element | null): void {
  const parent = element?.parentNode
  if (!element || !parent) return
  while (element.firstChild) parent.insertBefore(element.firstChild, element)
  parent.removeChild(element)
}

const sliceWrapper = (slice: Slice, selector: string): HTMLElement | null =>
  slice.node.parentElement?.closest<HTMLElement>(selector) ?? null

function wrapSlices(slices: Slice[], create: () => HTMLElement): HTMLElement[] {
  const wrappers: HTMLElement[] = []
  for (const { node, start, end } of slices) {
    if (!node.parentNode) continue
    const slice = document.createRange()
    slice.setStart(node, start)
    slice.setEnd(node, end)
    const wrapper = create()
    try {
      wrapper.appendChild(slice.extractContents())
      slice.insertNode(wrapper)
      wrappers.push(wrapper)
    } catch {
      // 这一段在处理途中被移出了文档树，保持原格式即可
    }
  }
  return wrappers
}

function selectWrappers(wrappers: HTMLElement[]): void {
  if (!wrappers.length) return
  const range = document.createRange()
  range.setStartBefore(wrappers[0])
  range.setEndAfter(wrappers[wrappers.length - 1])
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/**
 * 选区触及的每一段都已经是同款包裹 → 整体取消；否则先剥掉旧的再统一重包。
 * 换颜色走的就是后一条路（先 unwrap 再 wrap）。
 */
function toggleWrapper(
  editor: HTMLElement,
  range: Range,
  selector: string,
  create: () => HTMLElement,
  matches: (wrapper: HTMLElement) => boolean
): void {
  const slices = rangeSlices(editor, range)
  if (!slices.length) return
  const wrappers = slices.map((s) => sliceWrapper(s, selector))
  if (wrappers.every((w) => w && matches(w))) {
    // 这里不能 normalize()：预先算好的那批 run 必须保持有效
    for (const w of new Set(wrappers)) unwrap(w)
    return
  }
  for (const w of new Set(wrappers.filter(Boolean))) unwrap(w)
  selectWrappers(wrapSlices(slices, create))
}

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'mark' | 'color' | 'clear'

const CLEARABLE = ['mark', 'span.note-color', 'code', 'a', 'del', 's', 'strike', 'strong', 'b', 'em', 'i']

/**
 * 加粗/斜体/删除线交给浏览器原生命令——跨块选区的语义太碎，自己写不划算；
 * 颜色和高亮必须手写，因为 execCommand 产出的是 style="background-color:#..."，
 * 回读时映射不回颜色名。
 */
export function applyInlineFormat(
  editor: HTMLElement | null,
  kind: InlineFormat,
  value = '',
  askLink?: () => string | null
): void {
  const range = editorSelectionRange(editor)
  if (!editor || !range) return
  if (kind === 'bold' || kind === 'italic' || kind === 'strike') {
    document.execCommand(
      kind === 'bold' ? 'bold' : kind === 'italic' ? 'italic' : 'strikeThrough',
      false
    )
  } else if (kind === 'code') {
    toggleWrapper(editor, range, 'code', () => document.createElement('code'), () => true)
  } else if (kind === 'mark') {
    const token = colorToken(value, 'yellow') as NoteColor
    toggleWrapper(
      editor,
      range,
      'mark',
      () => {
        const mark = document.createElement('mark')
        mark.className = `note-mark note-mark-${token}`
        mark.dataset.color = token
        return mark
      },
      (w) => w.dataset.color === token
    )
  } else if (kind === 'color') {
    const token = colorToken(value, 'red') as NoteColor
    toggleWrapper(
      editor,
      range,
      'span.note-color',
      () => {
        const span = document.createElement('span')
        span.className = `note-color note-color-${token}`
        span.dataset.color = token
        return span
      },
      (w) => w.dataset.color === token
    )
  } else if (kind === 'link') {
    const href = askLink?.()
    if (!href || !/^https?:\/\//i.test(href)) return
    toggleWrapper(
      editor,
      range,
      'a',
      () => {
        const a = document.createElement('a')
        a.href = href
        a.target = '_blank'
        a.rel = 'noopener'
        return a
      },
      () => false
    )
  } else if (kind === 'clear') {
    for (const selector of CLEARABLE) {
      const current = editorSelectionRange(editor)
      if (!current) break
      const found = rangeSlices(editor, current)
        .map((s) => sliceWrapper(s, selector))
        .filter((w): w is HTMLElement => !!w)
      for (const w of new Set(found)) unwrap(w)
    }
  }
  editor.focus()
}

/** 去掉某个颜色/高亮包裹，色板上的「清除」用。 */
export function clearColorWrapper(editor: HTMLElement | null, kind: 'mark' | 'color'): void {
  const range = editorSelectionRange(editor)
  if (!editor || !range) return
  const selector = kind === 'mark' ? 'mark' : 'span.note-color'
  const found = rangeSlices(editor, range)
    .map((s) => sliceWrapper(s, selector))
    .filter((w): w is HTMLElement => !!w)
  for (const w of new Set(found)) unwrap(w)
  editor.focus()
}

/** 气泡工具栏定位：选区居中、贴视口留 8px、优先浮在上方，放不下翻到下方。 */
export function floatingBarPosition(
  range: Range,
  bar: { width: number; height: number },
  editorTop: number
): { top: number; left: number } | null {
  const rect = range.getBoundingClientRect()
  if (!rect.width && !rect.height) return null
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - bar.width / 2, 8),
    window.innerWidth - bar.width - 8
  )
  const above = rect.top - bar.height - 8
  const top = above > editorTop - bar.height ? above : rect.bottom + 8
  return { top: Math.max(8, top), left }
}

// DIV 必须在列表里：contentEditable 里新起的行常常是 <div> 而不是 <p>
// （Chromium 的 defaultParagraphSeparator 就是 div，光标不在已有块里时尤其如此）。
// 漏了它，新打的那一行 currentBlock 会返回 null，slash 菜单、Markdown 输入规则、
// 公式的块级渲染会一起静默失效——都以为「找不到块」而直接返回。
const BLOCK_TAGS = ['H1', 'H2', 'H3', 'P', 'DIV', 'BLOCKQUOTE', 'PRE', 'LI']

/** 光标所在的块元素，slash 菜单和输入规则要靠它替换整块。
 *  白名单之外还兜一层：编辑器的任何顶层子元素都能当块用——浏览器会造出什么标签
 *  不由我们决定，白名单漏一个就整条功能失效，代价太大。 */
export function currentBlock(editor: HTMLElement | null): HTMLElement | null {
  const selection = window.getSelection()
  if (!editor || !selection?.rangeCount) return null
  const start = selection.getRangeAt(0).startContainer
  if (!editor.contains(start)) return null
  let node: Node | null = start
  let topLevel: HTMLElement | null = null
  while (node && node !== editor) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (BLOCK_TAGS.includes(el.tagName)) return el
      if (el.parentNode === editor) topLevel = el
    }
    node = node.parentNode
  }
  return topLevel
}

export function placeCaret(node: Node, atEnd = true): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(!atEnd)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
