// 编辑器自己的撤销栈。
//
// 格式命令是直接改 DOM 的，浏览器原生的 undo 栈记不到这些改动——按 ⌘Z 会跳过它们、
// 把更早的输入撤掉，看起来就像乱跳。所以这个编辑器完全接管自己的历史。
//
// 光标位置按**纯文本偏移量**记，不记 DOM 路径：整段 innerHTML 重建之后，节点对象全换了，
// 只有文本偏移还对得上。

const LIMIT = 160
const COALESCE_MS = 400

interface Entry {
  html: string
  caret: { start: number; end: number }
}

export interface NoteHistory {
  entries: Entry[]
  index: number
  timer: number | undefined
  applying: boolean
}

export const createHistory = (): NoteHistory => ({
  entries: [],
  index: -1,
  timer: undefined,
  applying: false
})

/** 选区端点在编辑器纯文本里的偏移。 */
function caretOffsets(editor: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return { start: 0, end: 0 }
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.commonAncestorContainer)) return { start: 0, end: 0 }
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  return { start, end: start + range.toString().length }
}

function restoreCaret(editor: HTMLElement, caret: { start: number; end: number }): void {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null)
  let seen = 0
  let startNode: Node = editor
  let startOffset = 0
  let endNode: Node = editor
  let endOffset = 0
  let foundStart = false
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const len = node.nodeValue?.length ?? 0
    if (!foundStart && seen + len >= caret.start) {
      startNode = node
      startOffset = caret.start - seen
      foundStart = true
    }
    if (seen + len >= caret.end) {
      endNode = node
      endOffset = caret.end - seen
      break
    }
    seen += len
  }
  try {
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  } catch {
    // 偏移落在重建后不存在的位置，光标留在原处即可
  }
}

export function resetHistory(history: NoteHistory, editor: HTMLElement | null): void {
  window.clearTimeout(history.timer)
  history.timer = undefined
  history.applying = false
  history.entries = editor ? [{ html: editor.innerHTML, caret: { start: 0, end: 0 } }] : []
  history.index = history.entries.length - 1
}

/** 连续输入合并成一条（400ms 内），格式命令则立即提交，免得一次 ⌘Z 撤销半天的字。 */
export function commitHistory(
  history: NoteHistory,
  editor: HTMLElement | null,
  immediate = false
): void {
  if (!editor || history.applying) return
  const push = (): void => {
    const html = editor.innerHTML
    if (history.entries[history.index]?.html === html) return
    history.entries = history.entries.slice(0, history.index + 1)
    history.entries.push({ html, caret: caretOffsets(editor) })
    if (history.entries.length > LIMIT) history.entries.shift()
    history.index = history.entries.length - 1
  }
  window.clearTimeout(history.timer)
  history.timer = undefined
  if (immediate) {
    push()
    return
  }
  history.timer = window.setTimeout(push, COALESCE_MS)
}

/** delta 为 -1 撤销、+1 重做。返回是否真的动了。 */
export function stepHistory(
  history: NoteHistory,
  editor: HTMLElement | null,
  delta: number
): boolean {
  if (!editor) return false
  window.clearTimeout(history.timer)
  history.timer = undefined
  // 停在最新一条时先把当前状态记下来，否则第一次撤销会把刚敲的内容丢掉
  if (delta < 0 && history.index === history.entries.length - 1) {
    const html = editor.innerHTML
    if (history.entries[history.index]?.html !== html) {
      history.entries.push({ html, caret: caretOffsets(editor) })
      history.index = history.entries.length - 1
    }
  }
  const next = history.index + delta
  if (next < 0 || next >= history.entries.length) return false
  const entry = history.entries[next]
  history.applying = true
  editor.innerHTML = entry.html
  history.index = next
  restoreCaret(editor, entry.caret)
  history.applying = false
  return true
}
