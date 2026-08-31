// chat_messages：桌宠气泡与悬浮助手共用的一份对话历史。
// 整条消息按 JSON 原样存 payload——候选卡片、强制添加入口这些结构只有渲染层认识，
// 主进程不解释内容，只负责存取和条数上限。
import { getDb } from './connection.ts'
import { localNow } from '@shared/parsing'

/** 只留最近这么多条，避免历史无限长（长对话本来也只有最近 12 条进模型上下文）。 */
const MAX_MESSAGES = 200

export function listChatMessages(): unknown[] {
  const rows = getDb()
    .prepare('SELECT payload FROM chat_messages ORDER BY seq ASC')
    .all() as { payload: string }[]
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
export function saveChatMessages(msgs: unknown[]): void {
  const kept = msgs.slice(-MAX_MESSAGES)
  const db = getDb()
  const now = localNow()
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages').run()
    const ins = db.prepare('INSERT INTO chat_messages (seq, payload, created_at) VALUES (?, ?, ?)')
    kept.forEach((m, i) => ins.run(i, JSON.stringify(m), now))
  })()
}

export function clearChatMessages(): void {
  getDb().prepare('DELETE FROM chat_messages').run()
}
