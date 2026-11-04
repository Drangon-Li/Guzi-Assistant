// 飞书消息正文 → 解析用纯文本。
// 飞书把 @ 编码成占位符：文本消息里是 `@_user_1`，富文本里是 {tag:'at', user_id:'@_user_1'}，
// 真名只在事件的 mentions 里。占位符直接删掉的话，模型看不到点了谁，
// 「@林小谷 明天交方案」就只能判成待确认——所以这里按 mentions 还原成「@名字」。

export interface FeishuMention {
  key: string
  name?: string
}

interface PostNode {
  tag: string
  text?: string
  href?: string
  user_id?: string
  user_name?: string
}

export interface FeishuPost {
  title?: string
  content?: PostNode[][]
}

const ALL = '@所有人'
const PLACEHOLDER = /@_(?:user_\d+|all)(?![A-Za-z0-9_])/g

function mentionNames(mentions: FeishuMention[] | undefined): Map<string, string> {
  return new Map((mentions ?? []).filter((m) => m.key && m.name?.trim()).map((m) => [m.key, m.name!.trim()]))
}

function mentionText(key: string, names: Map<string, string>, fallbackName?: string): string {
  if (key === '@_all' || key === 'all') return ALL
  const name = names.get(key) ?? fallbackName?.trim()
  return name ? `@${name}` : '' // 对不上名字的占位符没有信息量，删掉
}

/** 文本消息：把 `@_user_N` / `@_all` 还原成「@名字」/「@所有人」。 */
export function restoreMentions(text: string, mentions?: FeishuMention[]): string {
  const names = mentionNames(mentions)
  return text.replace(PLACEHOLDER, (key) => mentionText(key, names))
}

/** 富文本（post）：标题 + 每行拼接，at 节点同样还原成「@名字」。 */
export function flattenPost(content: FeishuPost, mentions?: FeishuMention[]): string {
  const names = mentionNames(mentions)
  const lines = (content.content ?? []).map((line) =>
    line
      .map((node) =>
        node.tag === 'at' ? mentionText(node.user_id ?? '', names, node.user_name) : (node.text ?? node.href ?? '')
      )
      .join('')
  )
  return restoreMentions([content.title ?? '', ...lines].filter(Boolean).join('\n'), mentions)
}
