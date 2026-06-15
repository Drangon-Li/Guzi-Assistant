import {
  getProfile,
  listUnconsolidatedSources,
  markSourcesConsolidated,
  createMemory,
  createTask,
  taskExists,
  sourcesHaveTasks,
  allMemoryVectors,
  listMemories
} from './db'
import { callModel } from './parser'
import { embedTexts } from './embeddings'
import { broadcast } from './windows'
import {
  buildMemoryExtractionInstructions,
  parseMemoryExtractionOutput,
  isDuplicate,
  topK
} from '@shared/memory-extract'
import type { ConsolidateResult, MemoryRecord } from '@shared/types'

// 向量缓存：避免每次语义检索都从 SQLite 全量读 + JSON.parse 所有向量（压测发现这才是规模下的真瓶颈，
// 非余弦本身）。整理归档新增记忆后失效。个人量级（≤数万条）内存可控（~12MB/千条）。
let vecCache: ReturnType<typeof allMemoryVectors> | null = null
function memoryVectors(): ReturnType<typeof allMemoryVectors> {
  if (!vecCache) vecCache = allMemoryVectors()
  return vecCache
}

/**
 * #路线图 3a/3b/3c：把尚未整理的本地来源整理归档为「记忆」。
 * 借鉴 mem0 的设计（Apache-2.0）：每条来源 → LLM 抽原子自包含中文记忆 → 嵌入 → 跨记忆语义去重 →
 * 存本地（memories 表 + 向量）→ 从中识别待办。记忆/向量全部留在本地。
 */
export async function consolidateMemories(): Promise<ConsolidateResult> {
  const profile = getProfile()
  if (!profile) throw new Error('尚未完成用户档案设置')

  const sources = listUnconsolidatedSources(200)
  if (!sources.length) return { memories: 0, todos: 0, sourcesProcessed: 0 }

  const sys = buildMemoryExtractionInstructions(profile)
  const seen = allMemoryVectors().map((v) => ({ embedding: v.embedding })) // 已有记忆向量=去重基准
  let memCount = 0
  let todoCount = 0

  for (const s of sources) {
    const text = (s.content || s.excerpt || '').slice(0, 4000)
    if (!text.trim()) continue
    let mems: ReturnType<typeof parseMemoryExtractionOutput>
    try {
      const out = await callModel(sys, [{ role: 'user', content: [{ type: 'input_text', text }] }], 'parse_text')
      mems = parseMemoryExtractionOutput(out)
    } catch {
      continue // 单条来源失败不拖垮整批
    }
    if (!mems.length) continue

    let vecs: number[][] = []
    try {
      vecs = await embedTexts(mems.map((m) => m.text))
    } catch {
      vecs = [] // 嵌入失败仍存记忆，只是本条暂无向量（后续可补）
    }

    const alreadyActioned = sourcesHaveTasks([s.id]) // 已在捕获时产出任务的来源不重复造待办
    for (let i = 0; i < mems.length; i++) {
      const m = mems[i]
      const vec = vecs[i]
      if (vec && isDuplicate(vec, seen, 0.9)) continue // 与已有记忆语义重复 → 跳过
      if (vec) seen.push({ embedding: vec })
      createMemory({
        title: m.entities[0] || m.text.slice(0, 18),
        summary: m.text,
        entities: m.entities,
        timeRange: null,
        sourceIds: [s.id],
        embedding: vec
      })
      memCount++
      if (m.todo && !alreadyActioned && !taskExists(m.todo.title, m.todo.due_time)) {
        createTask({
          sourceId: s.id,
          title: m.todo.title,
          itemType: 'other',
          belongsToUser: 'yes',
          belongingReason: '由记忆抽取得出',
          userRole: 'owner',
          startTime: null,
          dueTime: m.todo.due_time,
          location: null,
          priority: 'unknown',
          confidence: 0.6,
          suggestedAction: 'confirm',
          evidence: [],
          notes: [],
          duplicateOf: null,
          status: 'pending',
          feedback: null
        })
        todoCount++
      }
    }
  }

  markSourcesConsolidated(sources.map((s) => s.id))
  if (memCount) vecCache = null // 新增记忆 → 向量缓存失效
  if (todoCount) broadcast('eshell:tasks-updated')
  return { memories: memCount, todos: todoCount, sourcesProcessed: sources.length }
}

/** 从记忆中语义检索（query 向量化 → 余弦 topK → 返回记忆）。空 query 返回最近记忆。 */
export async function searchMemoriesSemantic(query: string): Promise<MemoryRecord[]> {
  const q = query.trim()
  if (!q) return listMemories(50)
  const vectors = memoryVectors()
  if (!vectors.length) return []
  let qv: number[] | undefined
  try {
    ;[qv] = await embedTexts([q])
  } catch {
    return []
  }
  if (!qv) return []
  const ranked = topK(qv, vectors, 8).filter((r) => r.score > 0.2)
  const byId = new Map(listMemories(500).map((m) => [m.id, m]))
  return ranked.map((r) => byId.get(r.id)).filter((m): m is MemoryRecord => !!m)
}
