import {
  createSource,
  createTask,
  deleteSourceRow,
  findDuplicateTitle,
  getProfile,
  listTasks,
  personalMemoryText
} from './db'
import { broadcast } from './windows'
import { callModel } from './parser'
import {
  applyCandidatePatch,
  buildAssistantInstructions,
  parseAssistantOutput,
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
  broadcast('eshell:tasks-updated')
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
  if (!profile) return { reply: '', candidates: null, added: [], error: '尚未完成用户档案设置' }

  const tasks = listTasks()
    .filter((t) => t.status !== 'done' && t.status !== 'ignored')
    .slice(0, 60)
    .map((t) => ({
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

    let added: AddedInfo[] = []
    if (env.add.length && payload.candidates) {
      const items = payload.candidates.items
      const picks = env.add
        .map((a) => {
          const item = items[a.candidate - 1]
          if (!item) return null
          return {
            item: a.patch ? applyCandidatePatch(item, a.patch) : item,
            candidate: a.candidate,
            force: a.force
          }
        })
        .filter((p): p is { item: ParsedItem; candidate: number; force: boolean } => p !== null)
      if (picks.length) added = addCandidates(payload.candidates.sourceText, picks)
    }

    return {
      reply: env.reply,
      candidates: env.candidates.length ? env.candidates : null,
      added,
      error: null
    }
  } catch (e) {
    return { reply: '', candidates: null, added: [], error: e instanceof Error ? e.message : String(e) }
  }
}
