import type { Belongs, ItemType, Priority, Profile, SuggestedAction, UserRole } from './types'

export interface ParsedItem {
  title: string
  item_type: ItemType
  belongs_to_user: Belongs
  belonging_reason: string
  user_role: UserRole
  start_time: string | null
  due_time: string | null
  location: string | null
  priority: Priority
  confidence: number
  suggested_action: SuggestedAction
  evidence: string[]
}

/** 本地时区的 YYYY-MM-DDTHH:mm，与任务时间字段同格式，可直接字符串比较 */
export function localNow(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const IDENTITY_LABELS: Record<Profile['identity'], string> = {
  student: '大学生/研究生',
  worker: '职场新人',
  freelancer: '自由职业者'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function buildInstructions(profile: Profile): string {
  const lines = [
    `- 姓名：${profile.name}`,
    profile.nicknames.length ? `- 常用昵称/英文名：${profile.nicknames.join('、')}` : '',
    profile.accounts.length ? `- 常用账号名：${profile.accounts.join('、')}` : '',
    `- 身份：${IDENTITY_LABELS[profile.identity]}`,
    profile.org ? `- 组织/学校/公司：${profile.org}` : '',
    profile.group ? `- 班级/课题组/岗位/客户项目：${profile.group}` : ''
  ].filter(Boolean)

  const now = localNow()
  const weekday = WEEKDAYS[new Date().getDay()]

  return `你是 al1（个人事项捕获助手）的解析引擎。用户会提交剪切板文本、聊天截图、通知、邮件或文件内容，你需要从中提取「行动项/待办」，并判断每一项是否属于该用户本人。

# 用户档案
${lines.join('\n')}

# 归属判断规则
1. 内容明确点名用户姓名/昵称/账号 → belongs_to_user=yes，confidence 0.85~1.0，suggested_action=add。
2. 按角色/身份匹配（如"产品同学"且用户岗位是产品）→ belongs_to_user=yes 或 uncertain，confidence 0.6~0.85，suggested_action=confirm。
3. @所有人 / 全体成员 / 群发任务 → belongs_to_user=uncertain，confidence 不超过 0.7，suggested_action=confirm，绝不能直接 add。
4. 多人分工（A 做调研，B 做汇总）→ 只提取分配给用户的项；明确分配给别人的事项 belongs_to_user=no。
5. 模糊通知（"近期请大家完成填报"）→ uncertain，confidence 0.3~0.5，suggested_action=confirm。
6. 纯宣传/广告/讲座海报等无明确义务的内容 → 不生成任务；只有存在明确报名/缴费截止且与用户身份强相关时才生成 uncertain 项。
7. belonging_reason 用一句中文说明判断依据（如"内容点名了用户姓名张三"）。
8. evidence 必须是原文中逐字出现的句子或片段，每项 1~3 条。

# 时间解析
当前时间是 ${now}（${weekday}）。把"明天""周五前""6月20日"等相对时间解析为本地时间，格式 YYYY-MM-DDTHH:mm。只有日期没有具体时间的截止，时间用 23:59。原文没有提到时间的字段必须为 null，不要编造。

# 输出格式
只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：
{"items":[{"title":"任务标题","item_type":"deadline|meeting|reminder|preparation|follow_up|other","belongs_to_user":"yes|no|uncertain","belonging_reason":"判断依据","user_role":"owner|participant|notified|helper|unclear","start_time":"YYYY-MM-DDTHH:mm 或 null","due_time":"YYYY-MM-DDTHH:mm 或 null","location":"地点或 null","priority":"high|medium|low|unknown","confidence":0.0,"suggested_action":"add|confirm|ignore|ask_user","evidence":["原文片段"]}]}
没有可提取的任务时输出 {"items":[]}。`
}

export interface ResponsesOutput {
  error?: { message?: string } | null
  output_text?: string
  output?: { type: string; content?: { type: string; text?: string }[] }[]
}

export function extractText(data: ResponsesOutput): string {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text
  const parts: string[] = []
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && c.text) parts.push(c.text)
    }
  }
  return parts.join('\n')
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/

function normalizeTime(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null
  return v.length === 10 ? `${v}T23:59` : v.slice(0, 16)
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

export function normalizeItem(raw: Record<string, unknown>): ParsedItem | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return null
  const conf = typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.3
  return {
    title,
    item_type: oneOf(raw.item_type, ['deadline', 'meeting', 'reminder', 'preparation', 'follow_up', 'other'] as const, 'other'),
    belongs_to_user: oneOf(raw.belongs_to_user, ['yes', 'no', 'uncertain'] as const, 'uncertain'),
    belonging_reason: typeof raw.belonging_reason === 'string' ? raw.belonging_reason : '',
    user_role: oneOf(raw.user_role, ['owner', 'participant', 'notified', 'helper', 'unclear'] as const, 'unclear'),
    start_time: normalizeTime(raw.start_time),
    due_time: normalizeTime(raw.due_time),
    location: typeof raw.location === 'string' && raw.location ? raw.location : null,
    priority: oneOf(raw.priority, ['high', 'medium', 'low', 'unknown'] as const, 'unknown'),
    confidence: conf,
    suggested_action: oneOf(raw.suggested_action, ['add', 'confirm', 'ignore', 'ask_user'] as const, 'confirm'),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((e): e is string => typeof e === 'string').slice(0, 5) : []
  }
}

/** 从模型返回文本中截取 JSON 并规整为 ParsedItem 列表 */
export function parseModelOutput(text: string): ParsedItem[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('解析结果不是有效 JSON')
  let parsed: { items?: unknown[] }
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('解析结果 JSON 格式损坏')
  }
  const items = Array.isArray(parsed.items) ? parsed.items : []
  return items
    .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
    .map(normalizeItem)
    .filter((it): it is ParsedItem => it !== null)
}
