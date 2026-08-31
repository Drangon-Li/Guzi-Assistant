// 记事本插件的类型与纯逻辑：主进程和渲染层共用。
//
// 分类和标签是两套并行的归拢方式，互不影响：一篇笔记只能在一个分类里（像文件夹），
// 但可以打任意多个标签。分类回答「它放在哪」，标签回答「它关于什么」。

export interface NoteFolder {
  id: string
  name: string
  /** 顶层分类为 null；分类可以套分类 */
  parentId: string | null
  sortOrder: number
  createdAt: string
}

/** 列表用的轻量结构：不带正文，长笔记多了也不会把列表拖慢。 */
export interface NoteSummary {
  id: string
  folderId: string | null
  title: string
  /** 正文去掉 Markdown 标记后的开头，列表里当预览 */
  excerpt: string
  tags: string[]
  pinned: boolean
  /** 'report' 表示由日报存入，其余为手写 */
  source: string | null
  createdAt: string
  updatedAt: string
}

export interface NoteRecord extends NoteSummary {
  content: string
}

export interface FolderNode extends NoteFolder {
  children: FolderNode[]
  /** 直接放在这个分类下的笔记数，不含子分类 */
  noteCount: number
}

export interface NoteFilter {
  /** 'all' 全部，'none' 只看未分类，其余为分类 id */
  folderId?: string | null | 'all'
  tag?: string | null
  query?: string
}

const FENCE_RE = /```[\s\S]*?```/g
const MARK_RE: [RegExp, string][] = [
  // 颜色和高亮在正文里是内嵌标签，预览只要里面的字
  [/<\/?(?:mark|span)(?:\s+data-color="[a-z]+")?>/g, ''],
  [/^#{1,6}\s+/gm, ''],
  [/^\s*[-*+]\s+\[[ xX]\]\s*/gm, ''],
  [/^\s*[-*+]\s+/gm, ''],
  [/^\s*\d+[.、)]\s+/gm, ''],
  [/^\s*>\s?/gm, ''],
  [/!?\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/\*([^*]+)\*/g, '$1'],
  [/~~([^~]+)~~/g, '$1'],
  [/`([^`]+)`/g, '$1']
]

/** 正文的纯文本开头，供列表预览。整段代码块直接丢掉——预览里看半截代码没意义。 */
export function excerptOf(content: string, max = 80): string {
  let plain = content.replace(FENCE_RE, ' ')
  for (const [re, to] of MARK_RE) plain = plain.replace(re, to)
  plain = plain.replace(/\s+/g, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}

/**
 * 分类树。父分类不存在的挂到顶层——比整棵子树凭空消失好，用户还能把它拖回去。
 * 迭代建树，成环的数据也不会让这里递归爆栈（环内节点因为进不了根集合而自然落选）。
 */
export function buildFolderTree(
  folders: readonly NoteFolder[],
  notes: readonly { folderId: string | null }[] = []
): FolderNode[] {
  const counts = new Map<string, number>()
  for (const n of notes) {
    if (n.folderId) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1)
  }
  const nodes = new Map<string, FolderNode>()
  for (const f of folders) {
    nodes.set(f.id, { ...f, children: [], noteCount: counts.get(f.id) ?? 0 })
  }
  const roots: FolderNode[] = []
  for (const f of folders) {
    const node = nodes.get(f.id)
    if (!node) continue
    const parent = f.parentId ? nodes.get(f.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const bySort = (a: FolderNode, b: FolderNode): number =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh')
  const sortDeep = (list: FolderNode[]): void => {
    list.sort(bySort)
    for (const n of list) sortDeep(n.children)
  }
  sortDeep(roots)
  return roots
}

/** 某个分类的全部子孙 id（含自己）。移动分类时用来挡住「把父级拖进自己的子级」。 */
export function descendantIds(folders: readonly NoteFolder[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const f of folders) {
    if (!f.parentId) continue
    const list = childrenOf.get(f.parentId)
    if (list) list.push(f.id)
    else childrenOf.set(f.parentId, [f.id])
  }
  const out: string[] = []
  const queue = [rootId]
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    for (const child of childrenOf.get(id) ?? []) queue.push(child)
  }
  return out
}

/** 标签及用量，多的在前；同样多的按名字排，保证顺序稳定。 */
export function collectTags(notes: readonly { tags: string[] }[]): { tag: string; count: number }[] {
  const freq = new Map<string, number>()
  for (const n of notes) {
    for (const t of n.tags) freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return [...freq.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'))
}

/** 按分类 / 标签 / 关键词筛。三个条件同时生效，关键词匹标题、预览和标签。 */
export function filterNotes<T extends NoteSummary>(notes: readonly T[], f: NoteFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return notes.filter((n) => {
    if (f.folderId === 'none' && n.folderId) return false
    if (f.folderId && f.folderId !== 'all' && f.folderId !== 'none' && n.folderId !== f.folderId)
      return false
    if (f.tag && !n.tags.includes(f.tag)) return false
    if (!q) return true
    return (
      n.title.toLowerCase().includes(q) ||
      n.excerpt.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q))
    )
  })
}

/** 置顶的在前，其余按最近改动。列表和今日卡片共用这一个口径。 */
export function sortNotes<T extends NoteSummary>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

/** 标签规整：去空白、去重、丢掉空串，顺序保持用户输入的先后。 */
export function normalizeTags(input: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().slice(0, 24)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 20)
}

/** 日报存成笔记时的标题：日报自己的标题已经带日期，直接用。 */
export function titleFromContent(content: string, fallback = '未命名'): string {
  for (const line of content.split('\n')) {
    const t = line.replace(/^#{1,6}\s+/, '').trim()
    if (t) return t.slice(0, 60)
  }
  return fallback
}
