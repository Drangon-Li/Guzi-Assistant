// voice_sessions / voice_segments：语音纪要的会话与分段转录结果。
//
// 只存文字，不存音频。整场录音留在本地临时目录，转录完即删（用户可在设置里选择留存）——
// 会议录音是所有捕获里最敏感的一类，默认不进库。
import { getDb } from './connection.ts'
import { localNow } from '@shared/parsing'
import type { VoiceSessionRecord, VoiceSessionStatus } from '@shared/voicenotes'
import { randomUUID } from 'crypto'

interface SessionRow {
  id: string
  app: string | null
  started_at: string
  ended_at: string | null
  status: string
  transcript: string
  task_count: number
}

function rowToSession(r: SessionRow): VoiceSessionRecord {
  return {
    id: r.id,
    app: r.app,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status as VoiceSessionStatus,
    transcript: r.transcript,
    taskCount: r.task_count
  }
}

export function createVoiceSession(app: string | null): VoiceSessionRecord {
  const rec: VoiceSessionRecord = {
    id: randomUUID(),
    app,
    startedAt: localNow(),
    endedAt: null,
    status: 'recording',
    transcript: '',
    taskCount: 0
  }
  getDb()
    .prepare(
      'INSERT INTO voice_sessions (id, app, started_at, ended_at, status, transcript, task_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(rec.id, rec.app, rec.startedAt, null, rec.status, '', 0)
  // 会话历史不无界增长：只保留最近 100 场，段落跟着一起清
  getDb().exec(
    `DELETE FROM voice_segments WHERE session_id NOT IN (SELECT id FROM voice_sessions ORDER BY started_at DESC LIMIT 100);
     DELETE FROM voice_sessions WHERE id NOT IN (SELECT id FROM voice_sessions ORDER BY started_at DESC LIMIT 100);`
  )
  return rec
}

export function getVoiceSession(id: string): VoiceSessionRecord | null {
  const row = getDb().prepare('SELECT * FROM voice_sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined
  return row ? rowToSession(row) : null
}

export function listVoiceSessions(limit = 30): VoiceSessionRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM voice_sessions ORDER BY started_at DESC LIMIT ?')
    .all(limit) as SessionRow[]
  return rows.map(rowToSession)
}

/** 还在录的那一场（同一时刻至多一场）。崩溃重启后靠它把上次没收尾的会话捞回来。 */
export function activeVoiceSession(): VoiceSessionRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM voice_sessions WHERE status = 'recording' ORDER BY started_at DESC LIMIT 1")
    .get() as SessionRow | undefined
  return row ? rowToSession(row) : null
}

export function updateVoiceSession(
  id: string,
  patch: { status?: VoiceSessionStatus; endedAt?: string | null; transcript?: string; taskCount?: number }
): void {
  const sets: string[] = []
  const args: unknown[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?')
    args.push(patch.status)
  }
  if (patch.endedAt !== undefined) {
    sets.push('ended_at = ?')
    args.push(patch.endedAt)
  }
  if (patch.transcript !== undefined) {
    sets.push('transcript = ?')
    args.push(patch.transcript)
  }
  if (patch.taskCount !== undefined) {
    sets.push('task_count = ?')
    args.push(patch.taskCount)
  }
  if (!sets.length) return
  args.push(id)
  getDb().prepare(`UPDATE voice_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

export function addVoiceSegment(input: {
  sessionId: string
  seq: number
  durationMs: number
  text: string
}): void {
  getDb()
    .prepare(
      'INSERT INTO voice_segments (id, session_id, seq, started_at, duration_ms, text, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(randomUUID(), input.sessionId, input.seq, localNow(), input.durationMs, input.text, 'done')
}

/** 按顺序拼出整场转录。分段是乱序回来的（并发转录），落库时按 seq 排。 */
export function sessionTranscript(sessionId: string): string {
  const rows = getDb()
    .prepare('SELECT text FROM voice_segments WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as { text: string }[]
  return rows
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join('\n')
}

export function deleteVoiceSession(id: string): void {
  getDb().prepare('DELETE FROM voice_segments WHERE session_id = ?').run(id)
  getDb().prepare('DELETE FROM voice_sessions WHERE id = ?').run(id)
}
