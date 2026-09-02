// 笔记正文的 Markdown ⇄ HTML 双向转换，沿用谷子学术阅读笔记的那套设计。
//
// 存的是纯 Markdown。颜色和高亮标准语法里没有，用两个内嵌标签表达：
//   <mark data-color="yellow">…</mark>   <span data-color="red">…</span>
// 颜色只能是七个 token 之一，存名字而不是色值——明暗主题各自解析成不同的 CSS 变量，
// 换主题不用改笔记内容。
//
// 安全模型不靠消毒库：渲染时先把整段文本转义掉，再只把上面那两条**精确匹配**的
// 转义标签解回真标签。别的 HTML 永远保持转义原样显示，所以这是白名单而不是 innerHTML 直通。

export const NOTE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

/** 可通过 / 菜单或 Markdown 输入规则生成的块。 */
export type BlockKind = 'h1' | 'h2' | 'h3' | 'todo' | 'ul' | 'ol' | 'quote' | 'code' | 'divider'

// 块首打这些前缀再敲空格，就地变成对应的块——存的本来就是 Markdown，
// 手打 Markdown 却只能得到一行字面量「# 标题」，是这个编辑器一直缺的一环。
const BLOCK_RULES: [RegExp, BlockKind][] = [
  [/^###$/, 'h3'],
  [/^##$/, 'h2'],
  [/^#$/, 'h1'],
  [/^>$/, 'quote'],
  [/^[-*+]$/, 'ul'],
  [/^\d{1,9}[.、]$/, 'ol'],
  [/^\[[ xX]?\]$/, 'todo'],
  [/^(?:```|~~~)$/, 'code'],
  [/^(?:---|\*\*\*|___)$/, 'divider']
]

/**
 * 光标前那截文字是不是一条输入规则的触发前缀。
 * 传进来的应当是**块内光标之前的全部文字**：只有整段恰好等于前缀才算，
 * 也就是说只在块首触发——正文中间打个「#」不该把整块变成标题。
 */
export function markdownBlockRule(beforeCaret: string): BlockKind | null {
  const prefix = beforeCaret.trim()
  if (!prefix || prefix !== beforeCaret) return null // 前面有空格/缩进就不算块首
  for (const [re, kind] of BLOCK_RULES) if (re.test(prefix)) return kind
  return null
}

export const COLOR_LABELS: Record<NoteColor, string> = {
  red: '红色',
  orange: '橙色',
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  purple: '紫色',
  gray: '灰色'
}

const COLOR_PATTERN = NOTE_COLORS.join('|')

/**
 * 笔记里的图片只写文件名（内容 SHA-256 + 扩展名），本体在 userData 下。
 * 正文里不存 base64：那会让每次读写这一篇都拖着几 MB 走。
 * 这条正则同时是白名单——不符合的一律不当图片，挡住 ../ 和外部 URL。
 */
export const ASSET_ID_RE = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/
const ASSET_REF_RE = /!\[([^\]]*)\]\(asset:([a-f0-9]{64}\.(?:png|jpg|webp|gif))\)/g

export function colorToken(value: unknown, fallback: NoteColor | '' = ''): NoteColor | '' {
  const token = String(value ?? '')
    .trim()
    .toLowerCase()
  return (NOTE_COLORS as readonly string[]).includes(token) ? (token as NoteColor) : fallback
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
const escapeHTML = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c])

// ---------- HTML → Markdown ----------

const escapeText = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/([*_`[\]])/g, '\\$1')

/** 行首那几个字符在 Markdown 里有块级含义，正文里出现时要挡住，否则回读会变成标题或列表。 */
const escapeBlockStart = (value: string): string =>
  value
    .replace(/^(\s*)(#{1,6})(?=\s)/gmu, '$1\\$2')
    .replace(/^(\s*)([-+>])(?=\s)/gmu, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s)/gmu, '$1\\$2')

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'ul',
  'ol',
  'li',
  'pre',
  'blockquote',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article'
])

const hasBlockChild = (node: Node): boolean =>
  [...node.childNodes].some(
    (c) => c.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((c as Element).tagName.toLowerCase())
  )

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const content = [...el.childNodes].map(inlineMarkdown).join('')
  if (tag === 'br') return '\n'
  if (tag === 'strong' || tag === 'b') return content ? `**${content}**` : ''
  if (tag === 'em' || tag === 'i') return content ? `*${content}*` : ''
  if (tag === 'del' || tag === 's' || tag === 'strike') return content ? `~~${content}~~` : ''
  if (tag === 'mark') {
    return content ? `<mark data-color="${colorToken(el.dataset.color, 'yellow')}">${content}</mark>` : ''
  }
  if (tag === 'span' && colorToken(el.dataset.color)) {
    return content ? `<span data-color="${colorToken(el.dataset.color)}">${content}</span>` : ''
  }
  if (tag === 'img') {
    // 只认自己存下的图；外部拖进来的 img（比如从网页拖的）不留引用
    const asset = el.dataset.asset ?? ''
    return ASSET_ID_RE.test(asset) ? `![${escapeText(el.getAttribute('alt') ?? '')}](asset:${asset})` : ''
  }
  if (tag === 'code') return `\`${(el.textContent ?? '').replace(/`/g, '\\`')}\``
  if (tag === 'a') {
    const href = (el.getAttribute('href') ?? '').trim()
    return /^https?:\/\//i.test(href) && content ? `[${content}](${href})` : content
  }
  return content
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeBlockStart(escapeText(node.nodeValue ?? '').trim())
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const content = [...el.childNodes].map(inlineMarkdown).join('').trim()
  if (['strong', 'b', 'em', 'i', 'del', 's', 'mark', 'span', 'code', 'a', 'img'].includes(tag)) {
    return inlineMarkdown(el).trim()
  }
  if (/^h[1-3]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${content}`
  if (tag === 'hr') return '---'
  if (tag === 'blockquote') {
    return content
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
  }
  if (tag === 'ul' || tag === 'ol') {
    const todo = tag === 'ul' && el.classList.contains('note-todo')
    return [...el.children]
      .filter((c) => c.tagName === 'LI')
      .map((item, i) => {
        const text = [...item.childNodes]
          .filter((c) => !(c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName === 'INPUT'))
          .map(inlineMarkdown)
          .join('')
          .trim()
        if (todo) return `- [${(item as HTMLElement).dataset.checked === 'true' ? 'x' : ' '}] ${text}`
        return `${tag === 'ol' ? `${i + 1}.` : '-'} ${text}`
      })
      .join('\n')
  }
  if (tag === 'pre') {
    const code = [...el.children].find((c) => c.tagName === 'CODE')
    const lang = /language-([\w+#.-]+)/.exec(code?.className ?? '')?.[1] ?? ''
    return `\`\`\`${lang}\n${(el.textContent ?? '').replace(/\n+$/, '')}\n\`\`\``
  }
  if (tag === 'br') return ''
  // execCommand 造列表时会把它塞进原来的段落里（<p><ul>…</ul></p>），
  // 这种容器必须继续按块递归——走行内那条路会把整个列表丢掉。
  if (hasBlockChild(el)) {
    return [...el.childNodes].map(blockMarkdown).filter(Boolean).join('\n\n')
  }
  return escapeBlockStart(content)
}

/** 编辑器 DOM → Markdown 源码。保存和取摘要都走这里。 */
export function editorMarkdown(editor: HTMLElement): string {
  return [...editor.childNodes]
    .map(blockMarkdown)
    .filter((v) => v !== '')
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------- Markdown → HTML ----------

function inlineHTML(value: string): string {
  const escaped: string[] = []
  // 反斜杠转义的字符先抽走，免得后面的强调规则把它们当标记
  const parked = String(value ?? '').replace(/\\([\\*_`[\]#>+\-.!()])/g, (_m, ch: string) => {
    escaped.push(ch)
    return `\uE000${escaped.length - 1}\uE001`
  })
  let safe = escapeHTML(parked)
  // 图片要排在链接前面：![]() 也匹配 []() 的形状，顺序反了图片就成了链接。
  // src 留空，由编辑器挂载后按 data-asset 异步填 data URL（CSP 只放行 self 和 data:）。
  safe = safe.replace(ASSET_REF_RE, (_m, alt: string, id: string) => `<img data-asset="${id}" alt="${alt}">`)
  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  )
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>')
  safe = safe.replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/_(.+?)_/g, '<em>$1</em>')
  safe = safe.replace(/~~(.+?)~~/g, '<del>$1</del>')
  safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 全文转义之后，只有这两条精确匹配的标签被解回来——白名单，不是 innerHTML 洞
  safe = safe
    .replace(
      new RegExp(`&lt;mark data-color=&quot;(${COLOR_PATTERN})&quot;&gt;([\\s\\S]*?)&lt;/mark&gt;`, 'g'),
      (_m, token: string, inner: string) =>
        `<mark class="note-mark note-mark-${token}" data-color="${token}">${inner}</mark>`
    )
    .replace(
      new RegExp(`&lt;span data-color=&quot;(${COLOR_PATTERN})&quot;&gt;([\\s\\S]*?)&lt;/span&gt;`, 'g'),
      (_m, token: string, inner: string) =>
        `<span class="note-color note-color-${token}" data-color="${token}">${inner}</span>`
    )
  return safe.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => escapeHTML(escaped[Number(i)] ?? ''))
}

interface ListState {
  type: 'ul' | 'ol'
  todo: boolean
  items: { text: string; checked: boolean }[]
}

/** Markdown 源码 → 编辑器里的 HTML。只在载入一篇笔记时跑一次。 */
export function renderNoteHTML(markdown: string): string {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let list: ListState | null = null
  let fence: { lang: string; lines: string[] } | null = null

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    html.push(`<p>${paragraph.map(inlineHTML).join('<br>')}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    const items = list.items
      .map((item) =>
        list?.todo
          ? `<li data-checked="${item.checked}"><input type="checkbox" contenteditable="false"${
              item.checked ? ' checked' : ''
            }>${inlineHTML(item.text)}</li>`
          : `<li>${inlineHTML(item.text)}</li>`
      )
      .join('')
    html.push(`<${list.type}${list.todo ? ' class="note-todo"' : ''}>${items}</${list.type}>`)
    list = null
  }
  const flushFence = (): void => {
    if (!fence) return
    const lang = fence.lang ? ` class="language-${fence.lang}"` : ''
    html.push(`<pre><code${lang}>${escapeHTML(fence.lines.join('\n'))}</code></pre>`)
    fence = null
  }

  for (const line of lines) {
    const fenceOpen = /^```([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      if (fenceOpen) flushFence()
      else fence.lines.push(line)
      continue
    }
    if (fenceOpen) {
      flushParagraph()
      flushList()
      fence = { lang: fenceOpen[1], lines: [] }
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph()
      flushList()
      html.push('<hr>')
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      html.push(`<h${heading[1].length}>${inlineHTML(heading[2])}</h${heading[1].length}>`)
      continue
    }
    const todo = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line)
    if (todo) {
      flushParagraph()
      if (!list || list.type !== 'ul' || !list.todo) {
        flushList()
        list = { type: 'ul', todo: true, items: [] }
      }
      list.items.push({ text: todo[2], checked: todo[1].toLowerCase() === 'x' })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (bullet) {
      flushParagraph()
      if (!list || list.type !== 'ul' || list.todo) {
        flushList()
        list = { type: 'ul', todo: false, items: [] }
      }
      list.items.push({ text: bullet[1], checked: false })
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (!list || list.type !== 'ol') {
        flushList()
        list = { type: 'ol', todo: false, items: [] }
      }
      list.items.push({ text: ordered[1], checked: false })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      flushList()
      html.push(`<blockquote>${inlineHTML(quote[1])}</blockquote>`)
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  flushFence()
  return html.join('') || '<p><br></p>'
}
