import {
  getProfile,
  listUnconsolidatedSources,
  markSourcesConsolidated,
  createMemory,
  createTask,
  taskExists,
  sourcesHaveTasks
} from './db'
import { callModel } from './parser'
import { broadcast } from './windows'
import {
  buildConsolidationInstructions,
  formatConsolidationInput,
  parseConsolidationOutput,
  type ConsolidationInput
} from '@shared/memory-consolidate'
import type { ConsolidateResult } from '@shared/types'

/**
 * #路线图 3a/3b/3c：把尚未整理的本地来源批量「整理归档为记忆」——
 * 去噪 + 按事件聚类 + 摘要（走已验证的 memory-consolidate 算法 + 托管解析网关），
 * 记忆与关联全部存本地 SQLite；并把识别出的待办落为 pending 任务等用户确认。
 */
export async function consolidateMemories(): Promise<ConsolidateResult> {
  const profile = getProfile()
  if (!profile) throw new Error('尚未完成用户档案设置')

  const sources = listUnconsolidatedSources(200)
  if (!sources.length) return { memories: 0, todos: 0, sourcesProcessed: 0 }

  const inputs: ConsolidationInput[] = sources.map((s, i) => ({
    ref: i + 1,
    time: s.createdAt,
    type: s.type,
    text: (s.content || s.excerpt || '').slice(0, 4000)
  }))
  const refToId = new Map(inputs.map((it, i) => [it.ref, sources[i].id]))
  const allowed = new Set(inputs.map((it) => it.ref))

  const output = await callModel(
    buildConsolidationInstructions(profile),
    [{ role: 'user', content: [{ type: 'input_text', text: formatConsolidationInput(inputs) }] }],
    'parse_text'
  )
  const memories = parseConsolidationOutput(output, allowed)

  let todoCount = 0
  for (const m of memories) {
    const sourceIds = m.source_refs
      .map((r) => refToId.get(r))
      .filter((id): id is string => typeof id === 'string')
    createMemory({
      title: m.title,
      summary: m.summary,
      entities: m.entities,
      timeRange: m.time_range,
      sourceIds
    })
    // 该记忆的来源若已在捕获时产出过任务（如剪贴板/文件即时解析），就不再重复造待办；
    // 只对「未被处理过的来源」(典型=被动留存的屏幕感知流) 抽取待办，这正是整理归纳的增量价值。
    const alreadyActioned = sourcesHaveTasks(sourceIds)
    const primarySource = sourceIds[0] ?? null
    for (const todo of m.todos) {
      if (alreadyActioned) break
      if (taskExists(todo.title, todo.due_time)) continue // 与已有任务去重
      createTask({
        sourceId: primarySource,
        title: todo.title,
        itemType: 'other',
        belongsToUser: 'yes',
        belongingReason: '由记忆整理归纳得出',
        userRole: 'owner',
        startTime: null,
        dueTime: todo.due_time,
        location: null,
        priority: 'unknown',
        confidence: 0.6,
        suggestedAction: 'confirm',
        evidence: [],
        notes: [],
        duplicateOf: null,
        status: 'pending', // 进待确认，由用户确认后入日程
        feedback: null
      })
      todoCount++
    }
  }

  // 处理过的来源（含被判噪声、未进任何记忆的）统一标记，避免下次重复归纳
  markSourcesConsolidated(sources.map((s) => s.id))
  if (todoCount) broadcast('eshell:tasks-updated')
  return { memories: memories.length, todos: todoCount, sourcesProcessed: sources.length }
}
