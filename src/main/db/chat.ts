// chat_messages：助手对话历史，按 scope 分开存。
//
// 两个入口的消息结构本来就不一样（快捷提问那边还带任务操作和撤销），
// 与其硬凑成一种，不如各存各的：scope 区分，payload 原样存 JSON。
// 主进程不解释内容，只负责存取和条数上限。
import { getDb } from './connection.ts'
import { localNow } from '@shared/parsing'

/** 桌宠气泡与主窗悬浮助手共用这一份 */
export const CHAT_ASSISTANT = 'assistant'
/** 快捷提问框自己一份 */
export const CHAT_QUICKBAR = 'quickbar'

/** 只留最近这么多条，避免历史无限长（长对话本来也只有最近 12 条进模型上下文）。 */
const MAX_MESSAGES = 200

const scopeOf = (scope: unknown): string =>
  scope === CHAT_QUICKBAR ? CHAT_QUICKBAR : CHAT_ASSISTANT

export function listChatMessages(scope: string): unknown[] {
  const rows = getDb()
    .prepare('SELECT payload FROM chat_messages WHERE scope = ? ORDER BY seq ASC')
    .all(scopeOf(scope)) as { payload: string }[]
  const out: unknown[] = []
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload))
    } catch {
      // 一条坏记录不该让整段历史打不开
    }
  }
  return out
}

/** 整体覆盖。渲染层每次改动都送完整列表来，省掉增量对账——消息带上限，一次全写不贵。 */
export function saveChatMessages(scope: string, msgs: unknown[]): void {
  const key = scopeOf(scope)
  const kept = msgs.slice(-MAX_MESSAGES)
  const db = getDb()
  const now = localNow()
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE scope = ?').run(key)
    const ins = db.prepare(
      'INSERT INTO chat_messages (scope, seq, payload, created_at) VALUES (?, ?, ?, ?)'
    )
    kept.forEach((m, i) => ins.run(key, i, JSON.stringify(m), now))
  })()
}

export function clearChatMessages(scope: string): void {
  getDb().prepare('DELETE FROM chat_messages WHERE scope = ?').run(scopeOf(scope))
}
