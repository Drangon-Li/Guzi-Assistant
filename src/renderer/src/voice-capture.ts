// 麦克风采集：只有渲染层拿得到 getUserMedia，所以录音这一段必须在这里做。
//
// 产出 16kHz 单声道 16bit PCM，按**自然停顿**切段后交给主进程转录（借鉴 whisper-flow：
// 固定时钟窗口会把一句话拦腰截断，转录质量掉得很明显）。
//
// 用 ScriptProcessorNode 而不是 AudioWorklet：后者要单独打包一个 worklet 文件，
// 在 Electron 的 file:// 加载路径下还得处理 CSP 和相对路径；这里每秒才处理几十帧，
// 老 API 的性能问题在这个量级上无所谓，少一层构建复杂度更划算。

import {
  frameRms,
  isSilent,
  SAMPLE_RATE,
  segmentCut,
  type PcmSegment,
  type SegmentState
} from '@shared/voicenotes'
import { api } from './api'

const FRAME_SIZE = 4096 // ScriptProcessor 的缓冲大小，@16kHz 约 256ms 一帧

interface Recorder {
  stop: () => Promise<void>
}

let active: Recorder | null = null

export function isRecording(): boolean {
  return active !== null
}

/** Float32 [-1,1] → 16bit LE PCM。 */
function floatToPcm16(chunks: Float32Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total * 2)
  const view = new DataView(out.buffer)
  let offset = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      // clamp 后按 16bit 满量程缩放；不 clamp 的话超幅样本会绕回去变成爆音
      const v = Math.max(-1, Math.min(1, chunk[i]))
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      offset += 2
    }
  }
  return out
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // 一次性 apply 整个数组在长音频上会爆栈，分块拼
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/**
 * 开始录音。返回 stop 函数；已经在录时直接返回现有的那个。
 *
 * 失败（没授权、没设备）抛错，调用方负责提示——静默失败会让用户以为在录，
 * 开完会才发现什么都没有。
 */
export async function startCapture(sessionId: string): Promise<Recorder> {
  if (active) return active

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // 会议音频里这三样都开着更干净：回声消除尤其重要，否则会把扬声器里
      // 其他人的声音又录一遍，转录出来全是重复
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(FRAME_SIZE, 1, 1)

  let buffer: Float32Array[] = []
  let state: SegmentState = { durationMs: 0, silenceMs: 0, hasVoice: false }
  const frameMs = (FRAME_SIZE / SAMPLE_RATE) * 1000

  const flush = (): void => {
    const chunks = buffer
    const { durationMs, hasVoice } = state
    buffer = []
    state = { durationMs: 0, silenceMs: 0, hasVoice: false }
    if (!hasVoice || !chunks.length) return // 全静音的段不值得花一次转录调用
    const segment: PcmSegment = {
      sessionId,
      seq: 0, // 真正的顺序由主进程按到达次序分配
      durationMs: Math.round(durationMs),
      pcmBase64: toBase64(floatToPcm16(chunks))
    }
    void api.voiceSegment(segment)
  }

  processor.onaudioprocess = (e): void => {
    const input = e.inputBuffer.getChannelData(0)
    buffer.push(new Float32Array(input)) // 必须拷贝：这块内存下一帧会被复用
    const silent = isSilent(frameRms(input))
    state = {
      durationMs: state.durationMs + frameMs,
      silenceMs: silent ? state.silenceMs + frameMs : 0,
      hasVoice: state.hasVoice || !silent
    }
    if (segmentCut(state)) flush()
  }

  source.connect(processor)
  // ScriptProcessor 不接到 destination 就不会被调度；接一个零增益节点，
  // 避免把麦克风原样播回扬声器造成啸叫
  const mute = ctx.createGain()
  mute.gain.value = 0
  processor.connect(mute)
  mute.connect(ctx.destination)

  const recorder: Recorder = {
    stop: async () => {
      flush() // 最后一段也要送出去，否则会议最后几句永远丢失
      processor.disconnect()
      mute.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      await ctx.close().catch(() => {})
      active = null
    }
  }
  active = recorder
  return recorder
}

export async function stopCapture(): Promise<void> {
  await active?.stop()
}
