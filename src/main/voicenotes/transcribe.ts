// 语音转录客户端：OpenAI 兼容的 /v1/audio/transcriptions（multipart）。
//
// 刻意不复用 parser.ts 的 Responses 通道——那条是 JSON body 的文本接口，
// 转录要传二进制音频、走 multipart，两者除了「都带 Bearer」之外没有共用面。
// 端点、key、模型独立配置：转录模型和解析模型往往不在同一家。
import { getSettings } from '../db'
import type { PcmSegment } from '@shared/voicenotes'
import { pcmToWavBytes, SAMPLE_RATE, transcriptionEndpoint } from '@shared/voicenotes'

/** Buffer 版：主进程这边拿到的是 Buffer，套完头再转回 Buffer 交给 FormData。 */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  return Buffer.from(pcmToWavBytes(new Uint8Array(pcm), sampleRate))
}

export interface TranscribeResult {
  text: string
}

/** 转录一段音频。失败抛错，调用方决定是重试还是丢这一段。 */
export async function transcribeSegment(
  wav: Buffer,
  signal?: AbortSignal
): Promise<TranscribeResult> {
  const { voiceApiBase, voiceApiKey, voiceModel } = getSettings()
  if (!voiceApiBase || !voiceApiKey) {
    throw new Error('语音转录未配置，请在设置 → 语音纪要里填写 API 地址与 Key')
  }
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav')
  form.append('model', voiceModel || 'gpt-4o-mini-transcribe')
  form.append('response_format', 'json')
  // 会议里中英夹杂是常态，不锁死语言；模型自己判比强制指定更准

  let res: Response
  try {
    res = await fetch(transcriptionEndpoint(voiceApiBase), {
      method: 'POST',
      headers: { Authorization: `Bearer ${voiceApiKey}` },
      body: form,
      signal
    })
  } catch (e) {
    if (signal?.aborted) throw new Error('转录已取消')
    throw new Error(`转录服务无法访问：${e instanceof Error ? e.message : String(e)}`)
  }

  const raw = await res.text()
  if (!res.ok) {
    // 网关的报错体通常是 {error:{message}}，能读就读，读不出退回原文
    let detail = raw.slice(0, 300)
    try {
      const j = JSON.parse(raw) as { error?: { message?: string } }
      if (j.error?.message) detail = j.error.message
    } catch {
      /* 非 JSON 错误体，用原文 */
    }
    throw new Error(`转录失败（${res.status}）：${detail}`)
  }
  try {
    const j = JSON.parse(raw) as { text?: string }
    return { text: (j.text ?? '').trim() }
  } catch {
    throw new Error('转录返回的不是合法 JSON')
  }
}

/** 探测配置是否可用：设置页「测试连接」按钮用，拿一小段静音去打一次真实请求。 */
export async function probeTranscription(): Promise<{ ok: boolean; message: string }> {
  const { voiceApiBase, voiceApiKey, voiceModel } = getSettings()
  if (!voiceApiBase || !voiceApiKey) return { ok: false, message: '请先填写 API 地址与 Key' }
  // 半秒静音：足够让服务端走完鉴权和模型路由，又不会真的产生转录费用
  const silence = pcmToWav(Buffer.alloc(SAMPLE_RATE))
  try {
    await transcribeSegment(silence)
    return { ok: true, message: `连接成功，模型 ${voiceModel || 'gpt-4o-mini-transcribe'} 可用` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export type { PcmSegment }
