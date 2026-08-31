import {
  createSource,
  deleteSourceRow,
  findDuplicateTitle,
  getProfile,
  getTask,
  listTasks,
  personalMemoryText,
  updateTask
} from './db'
import { createTaskFromItem, scheduledStatus } from './task-ingest'
import { broadcast } from './windows'
import { applyExternalPetReaction, applyExternalPetSay } from './pet/controller'
import { buildDetectionCards, parsedToExtraction, showDetectedCards } from './detection-cards'
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
import type { PluginActionOutcome } from '@shared/parsing'
import type { TaskStatus } from '@shared/types'
import { assistantActions, assistantContext, runAssistantAction } from './plugins/index.ts'

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
    createTaskFromItem(source.id, item, scheduledStatus(item))
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

/**
 * 快捷提问框的后台结果播报：用户发完就把输入框关了（点外面/Esc），处理在主进程照常完成，
 * 结束后用桌宠气泡回报结果；模型给出的待确认候选转入检测卡 + 日程页「待确认」兜底区
 * （与屏幕感知/剪贴板同一条确认轨道），不会因为输入框关了而丢失。
 */
export function notifyQuickChatResult(
  res: AssistantTurnResult,
  lastUserText: string,
  hadPriorCandidates: boolean
): void {
  if (res.error) {
    applyExternalPetSay(`刚才那条没处理成功：${res.error.slice(0, 60)}`, 'waiting', { durationMs: 12_000 })
    return
  }
  const added = res.added.filter((a) => !a.duplicate)
  const dups = res.added.filter((a) => a.duplicate)
  const parts: string[] = []
  if (added.length === 1) parts.push(`已帮你记下「${added[0].title}」`)
  else if (added.length > 1) parts.push(`已帮你记下 ${added.length} 件事`)
  if (dups.length === 1) parts.push(`「${dups[0].title}」已经在日程里`)
  else if (dups.length > 1) parts.push(`${dups.length} 条已在日程里`)
  const doneOps = res.ops.filter((o) => o.action === 'done').length
  if (doneOps) parts.push(`标记完成 ${doneOps} 条`)
  if (res.ops.length - doneOps > 0) parts.push(`忽略 ${res.ops.length - doneOps} 条`)
  // 插件动作的结果直接用它自己的话播报（「开始专注 25 分钟」），失败的也说，
  // 否则用户以为定上了其实没有
  for (const a of res.actions) parts.push(a.message)

  // 本轮新给出、且没有当轮直接入库的候选：added 的序号只在「无上一轮候选上下文」时指向本轮候选
  const addedIdx = new Set(res.added.map((a) => a.candidate))
  const leftovers = (res.candidates ?? []).filter((_, i) => hadPriorCandidates || !addedIdx.has(i + 1))
  if (leftovers.length) {
    const cards = buildDetectionCards({
      hits: leftovers.map((item) => ({ extraction: parsedToExtraction(item), item })),
      sourceText: lastUserText,
      app: null,
      popup: true
    })
    showDetectedCards(cards)
    parts.push(leftovers.length > 1 ? `还有 ${leftovers.length} 条等你确认` : `「${leftovers[0].title}」等你确认`)
  }

  if (parts.length) {
    const good = added.length > 0 || doneOps > 0 || res.actions.some((a) => a.ok)
    applyExternalPetSay(`${parts.join('，')}～`, good ? 'success' : 'waiting', { durationMs: 12_000 })
    return
  }
  // 纯问答（没有任何日程动作）：气泡给出回答摘要，避免用户以为发丢了
  const reply = res.reply.replace(/\s+/g, ' ').trim()
  if (reply) applyExternalPetSay(reply.length > 80 ? `${reply.slice(0, 80)}…` : reply, 'waiting', { durationMs: 12_000 })
}

export async function assistantChat(payload: {
  history: ChatHistoryItem[]
  candidates: CandidateContext | null
}): Promise<AssistantTurnResult> {
  const profile = getProfile()
  if (!profile)
    return { reply: '', candidates: null, added: [], ops: [], actions: [], error: '尚未完成用户档案设置' }

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
        personalMemoryText(),
        assistantActions(), // 只列已启用插件的动作；一个都没启用时整段省略
        assistantContext() // 已启用插件的只读上下文（如笔记标题），用户排除的不在其中
      ),
      input,
      'chat' // 网关据此保留自然采样；此前默认走 parse_text 的 temperature 0，对话会发僵
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

    // 插件动作（「定个 25 分钟番茄钟」「今天的步数打卡」）：
    // runAssistantAction 会卡「插件已启用 + manifest 声明过 + 实现里有」三道门，
    // 模型编出来的插件或动作直接返回 null，当没这回事。
    const actions: PluginActionOutcome[] = []
    for (const a of env.actions) {
      const result = runAssistantAction(a.plugin, a.action, a.args)
      if (!result) continue
      actions.push({ plugin: a.plugin, action: a.action, ok: result.ok, message: result.message })
    }
    if (actions.length) {
      if (actions.some((a) => a.ok)) applyExternalPetReaction('success')
      broadcast('guzi-assistant:plugins-updated') // 插件页跟着刷新
    }

    return {
      reply: env.reply,
      candidates: env.candidates.length ? env.candidates : null,
      added,
      ops,
      actions,
      error: null
    }
  } catch (e) {
    return {
      reply: '',
      candidates: null,
      added: [],
      ops: [],
      actions: [],
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
