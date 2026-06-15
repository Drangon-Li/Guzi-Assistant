import type { Profile } from './types'
import { localNow, normalizeTime } from './parsing'

/**
 * 记忆提取（借鉴 mem0 的 ADDITIVE_EXTRACTION 设计，Apache-2.0；改为中文 + 本地化）：
 * 从单条被捕获内容里抽出「值得长期记住」的**原子、自包含、含时间锚点**的记忆，
 * 顺带识别隐含待办，并去噪/护凭据。检索与去重用纯 TS 余弦相似度（个人量级足够，免 native 依赖，跨平台/Win 友好）。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export interface ExtractedMemory {
  text: string // 自包含中文记忆句
  entities: string[]
  todo: { title: string; due_time: string | null } | null
}

function profileLine(p: Profile): string {
  const id =
    p.identity === 'student' ? '大学生/研究生' : p.identity === 'worker' ? '职场新人' : '自由职业者'
  const names = [p.name, ...(p.nicknames ?? [])].filter(Boolean).join('、')
  return `用户：${names}（${id}${p.org ? '，' + p.org : ''}${p.group ? '，' + p.group : ''}）`
}

/** mem0 式记忆提取系统提示词（中文、自包含、含时间锚点） */
export function buildMemoryExtractionInstructions(profile: Profile): string {
  const now = localNow()
  const weekday = WEEKDAYS[new Date().getDay()]
  return `你是记忆提取引擎。从用户被捕获的内容里提取「值得长期记住的事实/事项」，写成若干条**自包含、中文**的记忆。

# ${profileLine(profile)}
# 当前时间：${now}（${weekday}）

# 规则
1. 每条记忆独立成句、不依赖上下文指代，含「谁/做什么/何时/何地」等关键信息（15~60字）。相对时间（明天/周五前/后天）按当前时间解析成具体日期写进句子。
2. 去噪：界面菜单/按钮/广告促销/纯闲聊等不提取。**凭据**（验证码/密码/token/卡号）绝不写入任何字段。
3. 若该记忆隐含一个**用户本人需要做的待办**，附 todo：{"title":"动宾短语","due_time":"YYYY-MM-DDTHH:mm 或 null"}（只有日期没钟点的截止用 23:59；无时间则 null）；不含义务则 todo=null。
4. entities：涉及的人/课程/项目/地点/组织（无则空数组）。

# 输出格式
只输出一个 JSON，不要额外文字或代码块：
{"memories":[{"text":"自包含中文记忆","entities":[],"todo":{"title":"","due_time":null}}]}
无可提取时输出 {"memories":[]}。`
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('记忆提取结果不是有效 JSON')
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}

export function parseMemoryExtractionOutput(text: string): ExtractedMemory[] {
  const parsed = extractJson(text)
  const arr = Array.isArray(parsed.memories) ? parsed.memories : []
  const out: ExtractedMemory[] = []
  for (const m of arr) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as Record<string, unknown>
    const t = typeof r.text === 'string' ? r.text.trim() : ''
    if (!t) continue
    let todo: ExtractedMemory['todo'] = null
    if (r.todo && typeof r.todo === 'object') {
      const tr = r.todo as Record<string, unknown>
      const title = typeof tr.title === 'string' ? tr.title.trim() : ''
      if (title) todo = { title, due_time: normalizeTime(tr.due_time) }
    }
    out.push({
      text: t,
      entities: (Array.isArray(r.entities) ? r.entities : []).filter(
        (e): e is string => typeof e === 'string'
      ),
      todo
    })
  }
  return out
}

// ---------- 纯 TS 向量检索（个人量级暴力余弦，免 sqlite-vec native 依赖） ----------

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 返回与 query 向量最相似的若干项（降序），用于语义检索 */
export function topK<T extends { embedding: number[] }>(
  queryVec: number[],
  items: T[],
  k = 5
): (T & { score: number })[] {
  return items
    .map((it) => ({ ...it, score: cosineSim(queryVec, it.embedding) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
}

/** mem0 式去重：候选与已有记忆最大相似度 ≥ 阈值则视为重复 */
export function isDuplicate(
  candidateVec: number[],
  existing: { embedding: number[] }[],
  threshold = 0.9
): boolean {
  for (const e of existing) if (cosineSim(candidateVec, e.embedding) >= threshold) return true
  return false
}
