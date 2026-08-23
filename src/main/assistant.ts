import {
  createSource,
  createTask,
  deleteSourceRow,
  findDuplicateTitle,
  getProfile,
  getTask,
  listTasks,
  personalMemoryText,
  updateTask
} from './db'
import { broadcast } from './windows'
import { applyExternalPetReaction } from './pet/controller'
import { callModel } from './parser'
import {
  buildAssistantInstructions,
  parseAssistantOutput,
  resolveAddPicks,
  type AddedInfo,
  type AssistantTurnResult,
  type CandidateContext,
  type ChatHistoryItem,
  type ParsedItem
} from '@shared/parsing'
import type { TaskStatus } from '@shared/types'

function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** 聊天里确认过的事项直接进日程：确认动作已经在对话中发生，不再过待确认 */
function addCandidates(
  sourceText: string,
  picks: { item: ParsedItem; candidate: number; force: boolean }[]
): AddedInfo[] {
  const source = createSource({
    type: 'text_input',
    excerpt: excerptOf(sourceText),
    content: sourceText,
    filePath: null
  })
  let created = 0
  const added = picks.map(({ item, candidate, force }) => {
    const time = item.due_time ?? item.start_time
    // 疑似同一事件默认拦下，回传事项本体供用户选择「仍要加入」(force 跳过)
    if (!force && findDuplicateTitle(item.title, item.start_time, item.due_time)) {
      return { candidate, title: item.title, time, duplicate: true, item }
    }
    const status: TaskStatus = item.due_time || item.start_time ? 'scheduled' : 'not_started'
    createTask({
      sourceId: source.id,
      title: item.title,
      itemType: item.item_type,
      belongsToUser: item.belongs_to_user,
      belongingReason: item.belonging_reason,
      userRole: item.user_role,
      startTime: item.start_time,
      dueTime: item.due_time,
      location: item.location,
      priority: item.priority,
      confidence: item.confidence,
      suggestedAction: item.suggested_action,
      evidence: item.evidence,
      notes: item.notes,
      duplicateOf: item.duplicate_of,
      status,
      feedback: null
    })
    created++
    return { candidate, title: item.title, time, duplicate: false }
  })
  if (!created) deleteSourceRow(source.id)
  broadcast('guzi-assistant:tasks-updated')
  return added
}

/** 气泡卡上的「加入/仍要加入」按钮：不经过模型，直接入库 */
export function assistantAdd(payload: {
  sourceText: string
  item: ParsedItem
  force?: boolean
}): AddedInfo {
  return addCandidates(payload.sourceText, [
    { item: payload.item, candidate: 0, force: !!payload.force }
  ])[0]
}

export async function assistantChat(payload: {
  history: ChatHistoryItem[]
  candidates: CandidateContext | null
}): Promise<AssistantTurnResult> {
  const profile = getProfile()
  if (!profile) return { reply: '', candidates: null, added: [], ops: [], error: '尚未完成用户档案设置' }

  const tasks = listTasks()
    .filter((t) => t.status !== 'done' && t.status !== 'ignored')
    .slice(0, 60)
    .map((t) => ({
      id: t.id, // 供口头操作指令（ops）精确指认任务
      title: t.title,
      status: t.status,
      start_time: t.startTime,
      due_time: t.dueTime,
      location: t.location,
      priority: t.priority
    }))

  const input = payload.history.slice(-12).map((m) => ({
    role: m.role,
    content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }]
  }))

  try {
    const output = await callModel(
      buildAssistantInstructions(
        profile,
        JSON.stringify(tasks),
        payload.candidates?.items ?? null,
        personalMemoryText()
      ),
      input
    )
    const env = parseAssistantOutput(output)

    // add 的序号先指上一轮展示的候选，越界时回落到本轮新生成的候选——
    // 「明天提醒我干 XX」这类明确的创建请求没有上一轮候选，靠回落实现当轮直接入库
    let added: AddedInfo[] = []
    if (env.add.length) {
      const picks = resolveAddPicks(env.add, payload.candidates?.items ?? null, env.candidates)
      if (picks.length) {
        const sourceText =
          payload.candidates?.sourceText ??
          [...payload.history].reverse().find((m) => m.role === 'user')?.content ??
          ''
        added = addCandidates(sourceText, picks)
      }
    }

    // 口头指令操作已有任务（「XX 做完了标记完成」「把 XX 忽略」）：校验 id 真实存在再执行；
    // 带回原状态，UI 可一键撤销（口头指令没有确认环节，撤销是误伤的安全网）
    const ops: { id: string; title: string; action: 'done' | 'ignored'; prevStatus: TaskStatus }[] = []
    for (const op of env.ops) {
      const task = getTask(op.id)
      if (!task || task.status === op.action) continue
      updateTask(op.id, { status: op.action })
      ops.push({ id: op.id, title: task.title, action: op.action, prevStatus: task.status })
    }
    if (ops.length) {
      if (ops.some((o) => o.action === 'done')) applyExternalPetReaction('success')
      broadcast('guzi-assistant:tasks-updated')
    }

    return {
      reply: env.reply,
      candidates: env.candidates.length ? env.candidates : null,
      added,
      ops,
      error: null
    }
  } catch (e) {
    return {
      reply: '',
      candidates: null,
      added: [],
      ops: [],
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
