import type { Belongs, ItemType, Priority, Profile, SuggestedAction, TaskStatus, UserRole } from './types'

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
  notes: string[]
  duplicate_of: string | null
}

/** 本地时区 ISO 到秒：亚分钟排序场景用（如 app_switches——同一分钟内多次切换需稳定有序） */
export function localNowSec(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 本地时区的 YYYY-MM-DDTHH:mm，与任务时间字段同格式，可直接字符串比较 */
export function localNow(): string {
  return localNowSec().slice(0, 16)
}

const IDENTITY_LABELS: Record<Profile['identity'], string> = {
  student: '大学生/研究生',
  worker: '职场新人',
  freelancer: '自由职业者'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function profileBlock(profile: Profile): string {
  return [
    `- 姓名：${profile.name}`,
    profile.nicknames.length ? `- 常用昵称/英文名：${profile.nicknames.join('、')}` : '',
    profile.accounts.length ? `- 常用账号名：${profile.accounts.join('、')}` : '',
    `- 身份：${IDENTITY_LABELS[profile.identity]}`,
    profile.org ? `- 组织/学校/公司：${profile.org}` : '',
    profile.group ? `- 班级/课题组/岗位/客户项目：${profile.group}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

const BELONGING_RULES = `1. 内容明确点名用户姓名/昵称/账号 → belongs_to_user=yes，confidence 0.85~1.0，suggested_action=add。
2. 按角色/身份匹配（如"产品同学"且用户岗位是产品）→ belongs_to_user=yes 或 uncertain，confidence 0.6~0.85，suggested_action=confirm。
3. @所有人 / 全体成员 / 群发任务 → belongs_to_user=uncertain，confidence 不超过 0.7，suggested_action=confirm，绝不能直接 add。
4. 多人分工（A 做调研，B 做汇总）→ 只提取分配给用户的项；明确分配给别人的事项 belongs_to_user=no。
5. 模糊通知（"近期请大家完成填报"）→ uncertain，confidence 0.3~0.5，suggested_action=confirm。
5b. 点名了用户但语气委婉、无明确义务或时限的请求（"有空看一下""不急"）→ belongs 可为 yes，但 priority=low 且 suggested_action=confirm，不要 add。
6. 纯宣传/广告/讲座海报等无明确义务的内容 → 不生成任务；只有存在明确报名/缴费截止且与用户身份强相关时才生成 uncertain 项。
7. belonging_reason 用一句中文说明判断依据（如"内容点名了用户姓名张三"）。
8. evidence 必须是原文中逐字出现的句子或片段，每项 1~3 条。`

const EXTRACT_RULES = `- 原文中的密码、验证码、token、卡号等凭据**绝不能**出现在 title/notes 中（如需提及用 *** 代替）；evidence 优先选取不含凭据的句子。
- 地点尽量提取完整：楼宇/房间号/校区/会议室/线上会议链接等（如 "C8-8308 象山"）。
- notes：提取与该任务直接相关的注意事项、须知和准备要求（需携带的证件材料、提前到场时间、禁带物品、着装要求、联系方式等），每条凝练成一句话，按重要性排序，最多 10 条；没有则为空数组。
- 同一通知里的主事项与附属事项要拆成独立任务（如笔试和面试是两个任务），各自带自己的时间、地点和 notes。`

function timeRules(): string {
  const now = localNow()
  const weekday = WEEKDAYS[new Date().getDay()]
  return `当前时间是 ${now}（${weekday}）。把"明天""周五前""6月20日"等相对时间解析为本地时间，格式 YYYY-MM-DDTHH:mm。考试/会议等有明确开始时间的填 start_time；"X 前完成"类填 due_time；只有日期没有具体时间的截止，时间用 23:59。日期明确但只说"全天"或具体钟点待通知的活动，start_time 填当天 00:00，不要因为钟点未定就留 null。原文连日期都没有提到的字段必须为 null，不要编造。`
}

const ITEM_FIELDS = `{"title":"任务标题","item_type":"deadline|meeting|reminder|preparation|follow_up|other","belongs_to_user":"yes|no|uncertain","belonging_reason":"判断依据","user_role":"owner|participant|notified|helper|unclear","start_time":"YYYY-MM-DDTHH:mm 或 null","due_time":"YYYY-MM-DDTHH:mm 或 null","location":"地点或 null","priority":"high|medium|low|unknown","confidence":0.0,"suggested_action":"add|confirm|ignore|ask_user","notes":["注意事项，可为空数组"],"evidence":["原文片段"],"duplicate_of":"疑似与已有任务重复时填其标题，否则 null"}`

const DUP_RULE = `查重：把每个提取出的事项与「用户已有任务」对照，若明显是同一件事（同一事件的不同表述、同一时间点的同名活动），在 duplicate_of 字段填对应已有任务的标题；否则为 null。疑似重复的事项仍然要输出，由用户决定是否重复添加。`

export interface ExistingTaskBrief {
  title: string
  due_time: string | null
}

/** 个人记忆块：注入解析/助手 prompt，让判断贴合"这个用户是谁、在做什么"。空则不注入。 */
function memoryBlock(personalMemory: string): string {
  const m = personalMemory.trim()
  return m ? `\n# 关于该用户的记忆（历史归纳，供理解上下文，不要直接当作待办）\n${m.slice(0, 1500)}\n` : ''
}

/** 捕获解析（剪切板/截图/文件提交）的系统提示词 */
export function buildInstructions(
  profile: Profile,
  existingTasks: ExistingTaskBrief[] = [],
  belongingPrior = '',
  personalMemory = ''
): string {
  return `你是 谷子助手（个人事项捕获助手）的解析引擎。用户会提交剪切板文本、聊天截图、通知、邮件或文件内容，你需要从中提取「行动项/待办」，并判断每一项是否属于该用户本人。

# 用户档案
${profileBlock(profile)}
${belongingPrior ? '\n' + belongingPrior + '\n' : ''}${memoryBlock(personalMemory)}
# 用户已有任务（查重用）
${existingTasks.length ? JSON.stringify(existingTasks) : '（无）'}
${DUP_RULE}

# 归属判断规则
${BELONGING_RULES}

# 信息提取要求
${EXTRACT_RULES}

# 时间解析
${timeRules()}

# 输出格式
只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：
{"items":[${ITEM_FIELDS}]}
没有可提取的任务时输出 {"items":[]}。`
}

// ---------- 助手对话 ----------

export interface ChatHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

/** 上一轮生成的候选事项及其来源原文，作为下一轮对话的上下文 */
export interface CandidateContext {
  sourceText: string
  items: ParsedItem[]
}

export interface AddInstruction {
  candidate: number
  patch: Record<string, unknown> | null
  /** 用户明知重复仍要添加 */
  force: boolean
}

/** 用户口头指令对已有任务的操作（「XX 我做完了，标记完成」/「把 XX 忽略吧」） */
export interface TaskOpInstruction {
  id: string
  action: 'done' | 'ignored'
}

export interface AssistantEnvelope {
  reply: string
  candidates: ParsedItem[]
  add: AddInstruction[]
  ops: TaskOpInstruction[]
}

export interface AddedInfo {
  candidate: number
  title: string
  time: string | null
  duplicate: boolean
  /** duplicate=true 时回传被拦下的事项（含已应用的 patch），便于用户选择强制添加 */
  item?: ParsedItem
  /** 新建任务的 id（供云端校正回来更新已建任务，B Phase 1.5） */
  taskId?: string
}

export interface AssistantTurnResult {
  reply: string
  candidates: ParsedItem[] | null
  added: AddedInfo[]
  /** 本轮已执行的任务操作（标记完成/忽略）：带原状态供一键撤销 */
  ops: { id: string; title: string; action: 'done' | 'ignored'; prevStatus: TaskStatus }[]
  error: string | null
}

/** 助手对话的系统提示词：捕获 + 日程问答 + 候选确认三合一 */
export function buildAssistantInstructions(
  profile: Profile,
  tasksJson: string,
  candidates: ParsedItem[] | null,
  personalMemory = ''
): string {
  const now = localNow()
  const weekday = WEEKDAYS[new Date().getDay()]
  return `你是 谷子助手，${profile.name} 的个人事项助手。你帮用户从日常信息中捕获待办、回答日程问题、给出行动建议。语气自然、简洁、可靠，像一位靠谱的私人助理。

# 用户档案
${profileBlock(profile)}
${memoryBlock(personalMemory)}
# 当前时间
${now}（${weekday}）

# 用户的任务数据（最新）
${tasksJson}
status 含义：pending=待确认（用户还没确认，不算正式日程）、not_started=未开始、scheduled=已安排、in_progress=进行中、overdue=已延期。

# 输出格式
每轮只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：
{"reply":"对用户说的话","candidates":[],"add":[],"ops":[]}

## reply（必填）
简洁中文，可换行。列日程时一行一条、用「· 」开头，时间写成「6月15日 14:00」这种格式，并注明剩余时间（今天/明天/还有 N 天/已延期）。不要用 markdown 表格或标题。

## candidates（捕获场景才填）
当用户消息本质上是要记录的信息（粘贴的群通知/聊天记录/邮件/口头描述的事项）时，提取最多 3 个候选事项，按与用户的相关度排序；其余场景为 []。
每个候选的结构：${ITEM_FIELDS}
${DUP_RULE}（对照上方「用户的任务数据」；候选 duplicate_of 非空时在 reply 里提一句它可能与哪条已有任务重复）
归属判断规则：
${BELONGING_RULES}
时间解析：
${timeRules()}
信息提取要求：
${EXTRACT_RULES}
生成候选时，reply 简短说明发现了什么，并提醒用户可以点卡片加入，或直接用一句话告诉你选哪个、要改什么。

## add（用户确认候选时才填）
当用户明确表示要加入某个候选（如"加第一个""第二个吧，时间改到周五下午"）时填写：[{"candidate":候选序号,"patch":{要修改的字段}或null,"force":布尔，可省略}]。
用户消息本身就是明确的添加请求（"帮我记 XX""提醒我 XX""加个日程 XX"）且信息足够时，**同一轮**把该事项放进 candidates 并直接放进 add（不必等下一轮确认），reply 里确认已加入；信息不全（缺时间且看不出）再询问。
- candidate 是下方「当前候选列表」的序号，从 1 开始
- patch 只包含要修改的字段，可用：title/start_time/due_time/location/priority/item_type/notes；时间字段格式 YYYY-MM-DDTHH:mm
- 想加入的候选 duplicate_of 非空、且用户没有明确表示"仍要加/再加一条"时 → 不要放进 add，在 reply 里说明它与哪条已有任务重复并询问是否仍要添加
- 用户明确表示明知重复仍要添加 → 该项带 "force": true
- 加入后在 reply 里确认（标题 + 时间）；用户表示都不要时 add 为 [] 并在 reply 里确认不添加
- 没有候选时用户却要求添加 → 在 reply 里说明需要先把信息发给你

## ops（用户要求操作已有任务时才填）
当用户明确表示某个已有任务的状态变化（如"XX 我已经完成了，帮我标记完成""把 XX 忽略/删掉吧"）时填写：[{"id":"任务数据里该任务的 id","action":"done" 或 "ignored"}]。
- id 必须原样取自上方「用户的任务数据」；用户描述模糊、可能对应多条任务时**不要填 ops**，在 reply 里列出疑似项让用户确认
- done=标记完成；ignored=忽略/不再关注（用户说"删除"也用 ignored）
- 执行后在 reply 里用一句话确认（任务标题 + 做了什么）；找不到对应任务时 ops 为 [] 并在 reply 里直说

# 当前候选列表（用户上一轮收到的草稿）
${candidates && candidates.length ? JSON.stringify(candidates.map((c, i) => ({ 序号: i + 1, ...c }))) : '（无）'}

# 回答日程问题的原则
- "今天/最近有什么安排" → 从任务数据中按时间挑出相关项列出
- "哪些紧急" → 按截止时间近、优先级高排序，给前 2~3 个并说明原因
- "我现在该干什么" → 结合当前时间、截止压力和优先级，明确建议先做哪一件，给一两句理由
- 任务数据里没有的不要编造；没有匹配的任务就直说
- 提到 pending 状态的任务时，提醒用户它还在待确认，确认后才进日程`
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

function normalizeTime(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2}))?(?![\d:])/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  // 时间部分缺失按当天 23:59 截止；时间部分存在但非法则整体作废，宁缺勿错
  const hour = m[4] !== undefined ? Number(m[4]) : 23
  const minute = m[5] !== undefined ? Number(m[5]) : 59
  if (hour > 23 || minute > 59) return null
  const probe = new Date(year, month - 1, day)
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

const ITEM_TYPES = ['deadline', 'meeting', 'reminder', 'preparation', 'follow_up', 'other'] as const
const PRIORITIES = ['high', 'medium', 'low', 'unknown'] as const

export function normalizeItem(raw: Record<string, unknown>): ParsedItem | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return null
  const conf =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 0.3
  return {
    title,
    item_type: oneOf(raw.item_type, ITEM_TYPES, 'other'),
    belongs_to_user: oneOf(raw.belongs_to_user, ['yes', 'no', 'uncertain'] as const, 'uncertain'),
    belonging_reason: typeof raw.belonging_reason === 'string' ? raw.belonging_reason : '',
    user_role: oneOf(raw.user_role, ['owner', 'participant', 'notified', 'helper', 'unclear'] as const, 'unclear'),
    start_time: normalizeTime(raw.start_time),
    due_time: normalizeTime(raw.due_time),
    location: typeof raw.location === 'string' && raw.location ? raw.location : null,
    priority: oneOf(raw.priority, PRIORITIES, 'unknown'),
    confidence: conf,
    suggested_action: oneOf(raw.suggested_action, ['add', 'confirm', 'ignore', 'ask_user'] as const, 'confirm'),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((e): e is string => typeof e === 'string').slice(0, 5) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string').slice(0, 10) : [],
    duplicate_of: typeof raw.duplicate_of === 'string' && raw.duplicate_of ? raw.duplicate_of : null
  }
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('解析结果不是有效 JSON')
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    throw new Error('解析结果 JSON 格式损坏')
  }
}

/** 从屏幕扫描模型输出中取顶层 work_summary（「在做什么」一句话，工作记录用）；无/非法返回 null */
export function parseWorkSummary(text: string): string | null {
  try {
    const parsed = extractJson(text)
    const s = typeof parsed.work_summary === 'string' ? parsed.work_summary.trim() : ''
    return s ? s.slice(0, 200) : null
  } catch {
    return null
  }
}

/** 从屏幕扫描模型输出中取顶层 focus_task（任务级标签，专注时长用）；无/非法返回 null */
export function parseFocusTask(text: string): string | null {
  try {
    const parsed = extractJson(text)
    const s = typeof parsed.focus_task === 'string' ? parsed.focus_task.trim() : ''
    return s ? s.slice(0, 60) : null
  } catch {
    return null
  }
}

/** 从捕获解析的模型输出中规整 ParsedItem 列表 */
export function parseModelOutput(text: string): ParsedItem[] {
  const parsed = extractJson(text)
  const items = Array.isArray(parsed.items) ? parsed.items : []
  return items
    .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
    .map(normalizeItem)
    .filter((it): it is ParsedItem => it !== null)
}

/** 从助手对话的模型输出中规整 {reply, candidates, add} 信封 */
export function parseAssistantOutput(text: string): AssistantEnvelope {
  let parsed: Record<string, unknown>
  try {
    parsed = extractJson(text)
  } catch {
    // 模型偶尔不守约、直接输出对话原文（无 JSON 信封）：当纯回复用，不把格式问题抛给用户
    const plain = text.replace(/```[a-z]*\n?|```/gi, '').trim()
    return { reply: plain || '（无回复）', candidates: [], add: [], ops: [] }
  }
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
  const candidates = rawCandidates
    .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
    .map(normalizeItem)
    .filter((it): it is ParsedItem => it !== null)
    .slice(0, 3)
  const rawAdd = Array.isArray(parsed.add) ? parsed.add : []
  const add = rawAdd
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .filter((a) => typeof a.candidate === 'number' && Number.isInteger(a.candidate) && a.candidate >= 1)
    .map((a) => ({
      candidate: a.candidate as number,
      patch: typeof a.patch === 'object' && a.patch !== null ? (a.patch as Record<string, unknown>) : null,
      force: a.force === true
    }))
  const rawOps = Array.isArray(parsed.ops) ? parsed.ops : []
  const ops = rawOps
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .filter((o) => typeof o.id === 'string' && !!o.id && (o.action === 'done' || o.action === 'ignored'))
    .map((o) => ({ id: o.id as string, action: o.action as 'done' | 'ignored' }))
  return { reply: reply || (candidates.length ? '我发现了这些事项：' : '（无回复）'), candidates, add, ops }
}

/** 把对话中提出的修改应用到候选事项上（字段逐一校验，非法值忽略） */
export function applyCandidatePatch(item: ParsedItem, patch: Record<string, unknown>): ParsedItem {
  const next = { ...item }
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim()
  if ('start_time' in patch) next.start_time = normalizeTime(patch.start_time)
  if ('due_time' in patch) next.due_time = normalizeTime(patch.due_time)
  if ('location' in patch) {
    next.location = typeof patch.location === 'string' && patch.location ? patch.location : null
  }
  if ('priority' in patch) next.priority = oneOf(patch.priority, PRIORITIES, next.priority)
  if ('item_type' in patch) next.item_type = oneOf(patch.item_type, ITEM_TYPES, next.item_type)
  if (Array.isArray(patch.notes)) {
    next.notes = patch.notes.filter((n): n is string => typeof n === 'string').slice(0, 10)
  }
  return next
}
