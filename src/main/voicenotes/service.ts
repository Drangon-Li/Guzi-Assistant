// 语音纪要的生命周期：会议应用出现在前台 → 起录 → 分段转录 → 会议结束 → 解析任务清单。
//
// 录音本身在渲染层做（只有那里能拿 getUserMedia），主进程负责判定何时该录、
// 收分段、调转录、以及最后把转录文本变成任务。分工的理由：麦克风权限、AudioWorklet
// 都是渲染层的东西，而 API key、数据库、任务入库都在主进程，两边都不该跨界。

import { mkdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import {
  activeVoiceSession,
  addVoiceSegment,
  createVoiceSession,
  getSettings,
  getVoiceSession,
  sessionTranscript,
  updateVoiceSession
} from '../db'
import { getFrontmostContext } from '../frontapp'
import { privacyForContext } from '../privacy'
import { broadcast, debugEvent } from '../windows'
import { localNow } from '@shared/parsing'
import { meetingAppKind, type PcmSegment, type VoiceSessionRecord } from '@shared/voicenotes'
import { pcmToWav, transcribeSegment } from './transcribe'
import { parseVoiceTranscript } from './parse'
import { assertContentEpoch, captureContentEpoch, isContentEpochCurrent, isContentResetting, isExitPreparing } from '../content-lifecycle'

/** 会议应用离开前台多久算散会。开会时切去别的窗口查资料很常见，别一切走就收尾。 */
const LEAVE_GRACE_MS = 90_000
/** 前台检查间隔。会议起止是分钟级的事，5 秒够快了，比屏幕感知那条链路轻得多。 */
const POLL_MS = 5_000

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
let leftMeetingAt: number | null = null
/** 正在录的会话；null 表示没在录。渲染层靠 voice:state 事件跟这里对齐。 */
let current: VoiceSessionRecord | null = null
let nextSeq = 0
const completedSegments = new Set<number>()
let autoStartBlocked = false
let retryFinalization: VoiceSessionRecord | null = null
let stopping: Promise<void> | null = null
let captureStop: { sessionId: string; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null

export function acknowledgeVoiceCaptureStopped(sessionId: string): void {
  if (captureStop?.sessionId === sessionId) captureStop.resolve()
}

function waitForCaptureStop(sessionId: string): Promise<void> {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  const timeout = setTimeout(() => reject(new Error('录音窗口未确认停止，语音纪要尚未保存')), 180_000)
  const pending = { sessionId, promise, resolve, reject }
  captureStop = pending
  return promise.finally(() => {
    clearTimeout(timeout)
    if (captureStop === pending) captureStop = null
  })
}
/** 已派出去还没回来的转录请求数，收尾时要等它们落完 */
let pendingTranscriptions = 0
const transcriptionAborts = new Set<AbortController>()
const audioWrites = new Set<Promise<void>>()

export function currentVoiceSession(): VoiceSessionRecord | null {
  return current
}

function emitState(): void {
  broadcast('guzi-assistant:voice-state', current)
}

/** 开一场。app 为触发录制的应用名，手动起录时传 null。 */
export function startVoiceSession(appName: string | null): VoiceSessionRecord {
  captureContentEpoch()
  if (current) return current
  current = createVoiceSession(appName)
  nextSeq = 0
  completedSegments.clear()
  leftMeetingAt = null
  debugEvent('voice', `开始录制语音纪要${appName ? `（${appName}）` : '（手动）'}`)
  emitState()
  return current
}

/**
 * 收一场：采集确认停止 → 等在途转录落完 → 拼全文 → 解析任务。
 */
export function stopVoiceSession(): Promise<void> {
  if (stopping) return stopping
  const run = finishVoiceSession().finally(() => { if (stopping === run) stopping = null })
  stopping = run
  return run
}

async function finishVoiceSession(): Promise<void> {
  const epoch = captureContentEpoch()
  const session = current ?? retryFinalization
  if (!session) return
  retryFinalization = session
  autoStartBlocked = true
  if (current) {
    const stopped = waitForCaptureStop(session.id)
    current = { ...session, status: 'finalizing' }
    emitState()
    await stopped
    if (!isContentEpochCurrent(epoch)) return
    current = null
  }
  leftMeetingAt = null
  updateVoiceSession(session.id, { status: 'finalizing', endedAt: localNow() })
  emitState()
  debugEvent('voice', '录制结束，正在转录与解析')

  // 在途的分段还在转录，等它们落库再拼全文，否则会漏掉最后几句
  const deadline = Date.now() + 60_000
  while (pendingTranscriptions > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
    if (!isContentEpochCurrent(epoch)) return
  }

  if (!isContentEpochCurrent(epoch)) return
  if (pendingTranscriptions > 0) throw new Error('语音转录尚未完成，请稍后重试')

  const transcript = sessionTranscript(session.id)
  updateVoiceSession(session.id, { transcript })
  if (!transcript.trim()) {
    updateVoiceSession(session.id, { status: 'done', taskCount: 0 })
    debugEvent('voice', '这一场没有转录到内容')
    broadcast('guzi-assistant:voice-updated')
    retryFinalization = null
    return
  }
  try {
    const count = await parseVoiceTranscript(transcript, session.app)
    assertContentEpoch(epoch)
    updateVoiceSession(session.id, { status: 'done', taskCount: count })
    debugEvent('voice', `解析完成：${count} 条任务待确认`)
  } catch (e) {
    if (!isContentEpochCurrent(epoch)) return
    updateVoiceSession(session.id, { status: 'failed' })
    debugEvent('voice', `解析失败：${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
  retryFinalization = null
  broadcast('guzi-assistant:voice-updated')
  broadcast('guzi-assistant:tasks-updated')
}

/**
 * 收一段 PCM：转 WAV → 转录 → 落库。
 * 逐段转录（而不是攒到最后一次性传）是为了「逐步解析」：会议还没结束，
 * 前面的内容已经转好了，UI 上能实时看到文字在长出来。
 */
export async function ingestSegment(segment: PcmSegment): Promise<void> {
  if (isContentResetting()) return
  const epoch = captureContentEpoch()
  const session = current
  if (!session || session.id !== segment.sessionId) return
  const seq = Number.isInteger(segment.seq) && segment.seq >= 0 ? segment.seq : nextSeq
  nextSeq = Math.max(nextSeq, seq + 1)
  if (completedSegments.has(seq)) {
    updateVoiceSession(session.id, { transcript: sessionTranscript(session.id) })
    return
  }
  pendingTranscriptions += 1
  const controller = new AbortController()
  transcriptionAborts.add(controller)
  const wav = pcmToWav(Buffer.from(segment.pcmBase64, 'base64'))
  let audioPath: string | null = null
  try {
    if (getSettings().voiceKeepAudio) {
      // 留存是 opt-in：默认整场录音都不落盘，只有这一段的字节在内存里过一趟
      const dir = join(app.getPath('userData'), 'voice-notes')
      audioPath = join(dir, `${session.id}-${seq}.wav`)
      const write = mkdir(dir, { recursive: true }).then(() => {
        assertContentEpoch(epoch)
        return writeFile(audioPath as string, wav)
      })
      audioWrites.add(write)
      try {
        await write
      } finally {
        audioWrites.delete(write)
      }
    }
    assertContentEpoch(epoch)
    const { text } = await transcribeSegment(wav, controller.signal)
    assertContentEpoch(epoch)
    if (text) {
      addVoiceSegment({ sessionId: session.id, seq, durationMs: segment.durationMs, text })
      completedSegments.add(seq)
      const transcript = sessionTranscript(session.id)
      updateVoiceSession(session.id, { transcript })
      broadcast('guzi-assistant:voice-updated')
    }
  } catch (e) {
    // 单段失败不该毁掉整场：记一笔，继续录下一段
    if (isContentEpochCurrent(epoch)) {
      debugEvent('voice', `分段 ${seq} 转录失败：${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  } finally {
    transcriptionAborts.delete(controller)
    if (isContentEpochCurrent(epoch)) pendingTranscriptions -= 1
    if (audioPath && (!isContentEpochCurrent(epoch) || !getSettings().voiceKeepAudio))
      await unlink(audioPath).catch(() => {})
  }
}

/** 一轮前台检查：会议应用来了就起录，走了超过宽限期就收尾。 */
async function tick(): Promise<void> {
  if (ticking || isContentResetting() || isExitPreparing()) return
  const epoch = captureContentEpoch()
  ticking = true
  try {
    const { voiceNotesEnabled, voiceAutoStart } = getSettings()
    if (!voiceNotesEnabled) {
      if (current) await stopVoiceSession()
      return
    }
    if (!voiceAutoStart) return // 只允许手动起录

    const context = await getFrontmostContext()
    assertContentEpoch(epoch)
    if (!context?.name) return // 拿不到前台上下文就什么都不做，绝不盲录

    // 排除名单/私密窗口一样要挡住：用户把某个应用列进排除名单，是不希望谷子在那里工作
    const { suppressed } = privacyForContext(context)
    const kind = suppressed
      ? null
      : meetingAppKind(context.name, context.bundleId, context.windowTitle)

    if (kind) {
      leftMeetingAt = null
      if (!current && !autoStartBlocked) startVoiceSession(context.name)
      return
    }
    autoStartBlocked = false
    if (!current) return
    // 会议应用不在前台了：给一段宽限，开会时切去查资料是常事
    if (leftMeetingAt === null) leftMeetingAt = Date.now()
    else if (Date.now() - leftMeetingAt >= LEAVE_GRACE_MS) await stopVoiceSession()
  } catch (e) {
    if (isContentEpochCurrent(epoch))
      debugEvent('voice', `轮询异常：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    ticking = false
  }
}

export function startVoiceWatch(): void {
  if (timer) return
  timer = setInterval(() => void tick(), POLL_MS)
  debugEvent('voice', '语音纪要监听已启动')
}

export function stopVoiceWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** 清空不走正常停止的解析收尾；只取消录制和在途工作。 */
export async function resetVoiceContent(): Promise<void> {
  stopVoiceWatch()
  current = null
  retryFinalization = null
  stopping = null
  completedSegments.clear()
  captureStop?.resolve()
  captureStop = null
  leftMeetingAt = null
  nextSeq = 0
  pendingTranscriptions = 0
  for (const controller of transcriptionAborts) controller.abort()
  transcriptionAborts.clear()
  emitState()
  await Promise.allSettled([...audioWrites])
}

/** 设置变更后重新对齐：开关关掉要立刻收尾，打开要把轮询拉起来。 */
export function applyVoiceSettings(): void {
  const { voiceNotesEnabled } = getSettings()
  if (voiceNotesEnabled) startVoiceWatch()
  else {
    stopVoiceWatch()
    if (current) void stopVoiceSession()
  }
}

/** 启动时兜底：上次崩溃/强退留下的 recording 会话收尾成 failed，不然它会永远挂着。 */
export function recoverStaleVoiceSession(): void {
  const stale = activeVoiceSession()
  if (!stale) return
  updateVoiceSession(stale.id, { status: 'failed', endedAt: localNow() })
  debugEvent('voice', `上次未正常收尾的录制已标记失败：${stale.id}`)
}

export { getVoiceSession }
