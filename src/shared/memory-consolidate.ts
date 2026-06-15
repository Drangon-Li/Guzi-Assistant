import type { Profile } from './types'
import { localNow, normalizeTime } from './parsing'

/**
 * 记忆整理归纳（#路线图 3a/3b/3c）：把一段时间内被捕获的零散来源（屏幕 OCR / 剪贴板 / 通知 / 聊天 / 文件片段）
 * 按主题/事件/实体归纳成若干条「记忆」，并从中抽取与用户本人相关的待办。
 * 思路参考 MineContext：批量消费原始 context → 去噪 + 聚类 + 摘要 → 结构化记忆。
 * 这里用「一次 LLM 调用消费一批来源」的批式整理（个人量级一天的捕获可放进上下文），算法本体为纯函数，便于数据集验证。
 */

/** 送入整理的单条原始来源（ref 是稳定编号，便于模型回指与回溯到 source_id） */
export interface ConsolidationInput {
  ref: number
  time: string // YYYY-MM-DDTHH:mm
  type: string // 来源类型（screen_scan / clipboard_text / feishu ...）
  text: string
}

export interface MemoryTodo {
  title: string
  due_time: string | null
}

export interface ConsolidatedMemory {
  title: string
  summary: string
  entities: string[]
  time_range: string | null
  source_refs: number[]
  todos: MemoryTodo[]
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function profileLine(p: Profile): string {
  const id =
    p.identity === 'student' ? '大学生/研究生' : p.identity === 'worker' ? '职场新人' : '自由职业者'
  const bits = [p.name, ...(p.nicknames ?? [])].filter(Boolean).join('、')
  return `用户：${bits}（${id}${p.org ? '，' + p.org : ''}${p.group ? '，' + p.group : ''}）`
}

const MEMORY_FIELDS = `{"title":"简短标题","summary":"1~3句客观转述：发生了什么、关键信息","entities":["涉及的人/课程/项目/地点/组织"],"time_range":"涉及时间(如 6月18-19日 / 6月20日 23:59)或 null","source_refs":[归入这条记忆的原始编号],"todos":[{"title":"与用户本人相关的待办","due_time":"YYYY-MM-DDTHH:mm 或 null"}]}`

/** 整理归纳的系统提示词 */
export function buildConsolidationInstructions(profile: Profile): string {
  const now = localNow()
  const weekday = WEEKDAYS[new Date().getDay()]
  return `你是 纸壳助手 的记忆整理引擎。下面会给你一批用户在一段时间内被捕获的零散内容（屏幕识别文字、剪切板、通知、聊天片段、文件片段），每条带编号 [n]、时间和来源类型。请把它们归纳成若干条「记忆」。

# ${profileLine(profile)}
# 当前时间：${now}（${weekday}）

# 归纳规则
1. 把属于**同一件事/同一主题/同一事件线**的多条原始内容合并成**一条**记忆；不相关的分到不同记忆。
2. **去噪**：界面菜单/按钮/导航等无意义片段、广告促销、纯闲聊、验证码/密码等，不要单独成为记忆；若整批里某条只是噪声，直接忽略它（不计入任何 source_refs）。
3. 每条记忆按客观事实转述，不要编造原文没有的信息。
4. **凭据**（验证码、密码、token、卡号）绝不能出现在任何字段里。
5. todos 只收录**与用户本人相关、确有行动义务**的待办；群发且与用户身份无关、或纯通知性内容不要塞 todo。把"明天/周五前/6月20日"等相对时间按当前时间解析为 YYYY-MM-DDTHH:mm（只有日期没钟点的截止用 23:59；原文没提到时间则 null）。
6. source_refs 必须是输入中真实出现过的编号。

# 输出格式
只输出一个 JSON 对象，不要任何额外文字或代码块标记：
{"memories":[${MEMORY_FIELDS}]}
没有可归纳内容时输出 {"memories":[]}。`
}

/** 把整理的输入批组装成给模型的文本块 */
export function formatConsolidationInput(items: ConsolidationInput[]): string {
  return items
    .map((it) => `[${it.ref}] (${it.time} · ${it.type}) ${it.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('整理结果不是有效 JSON')
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}

function normalizeTodo(raw: unknown): MemoryTodo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title) return null
  return { title, due_time: normalizeTime(r.due_time) }
}

/** 校验允许的 refs，过滤模型回指里不存在的编号 */
export function parseConsolidationOutput(
  text: string,
  allowedRefs?: ReadonlySet<number>
): ConsolidatedMemory[] {
  const parsed = extractJson(text)
  const arr = Array.isArray(parsed.memories) ? parsed.memories : []
  const out: ConsolidatedMemory[] = []
  for (const m of arr) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    if (!title) continue
    const refs = (Array.isArray(r.source_refs) ? r.source_refs : [])
      .map((n) => (typeof n === 'number' ? n : Number(n)))
      .filter((n) => Number.isInteger(n) && (!allowedRefs || allowedRefs.has(n)))
    out.push({
      title,
      summary: typeof r.summary === 'string' ? r.summary.trim() : '',
      entities: (Array.isArray(r.entities) ? r.entities : []).filter(
        (e): e is string => typeof e === 'string'
      ),
      time_range: typeof r.time_range === 'string' && r.time_range.trim() ? r.time_range.trim() : null,
      source_refs: refs,
      todos: (Array.isArray(r.todos) ? r.todos : [])
        .map(normalizeTodo)
        .filter((t): t is MemoryTodo => t !== null)
    })
  }
  return out
}
