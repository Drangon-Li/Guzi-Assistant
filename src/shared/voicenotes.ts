// 语音纪要：会议应用识别、按停顿切段、以及给解析用的「用户最近在干什么」上下文。
//
// 三条借鉴：
//  - openwhispr：靠「前台是不是会议应用」自动起录，而不是常驻听麦克风。谷子本来就有前台
//    上下文（frontapp.ts），复用即可，代价几乎为零，也不用一直占着麦克风。
//  - whisper-flow：按**自然停顿**切段，不按固定时钟窗口。会议里一句话被拦腰截断，
//    转录质量掉得很厉害；停顿处切开，每段都是完整的一句或几句。
//  - vibe：音频默认不出本机——只有要转录的那一段出去，整场录音留在本地且可一键不留。
//
// 与 todo-scan.ts 的 App 词典口径不同（那是「值得为抓待办看一眼屏幕」的内容型应用），
// 这里问的是「这是不是一场会」，故不复用。

export type MeetingAppKind = 'conference' | 'call' | null

// bundleId 精确匹配优先：同一个应用改了显示名（Zoom 改过好几次）也还认得。
const MEETING_BUNDLES: Record<string, Exclude<MeetingAppKind, null>> = {
  'us.zoom.xos': 'conference',
  'com.microsoft.teams': 'conference',
  'com.microsoft.teams2': 'conference',
  'com.tencent.meeting': 'conference',
  'com.tencent.wemeet': 'conference',
  'com.bytedance.lark': 'conference', // 飞书：会议和 IM 同一个进程，靠窗口标题再确认
  'com.electron.lark': 'conference',
  'com.alibaba.dingtalk': 'conference',
  'com.webex.meetingmanager': 'conference',
  'com.cisco.webexmeetingsapp': 'conference',
  'com.google.chrome': 'conference', // 浏览器里的 Meet/Teams，同样靠标题确认
  'com.apple.safari': 'conference',
  'com.apple.facetime': 'call',
  'com.tencent.xinwechat': 'call' // 微信语音/视频通话
}

const MEETING_NAMES: [readonly string[], Exclude<MeetingAppKind, null>][] = [
  [['zoom', '腾讯会议', 'wemeet', 'tencent meeting', 'webex', 'teams', '飞书', 'lark', '钉钉', 'dingtalk'], 'conference'],
  [['facetime', '面对面', 'skype', 'discord'], 'call']
]

/** 浏览器和 IM 里只有窗口标题能区分「在开会」和「在划水」。 */
const MEETING_TITLE_HINTS = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'webex',
  '会议中',
  '正在会议',
  'meeting',
  '视频通话',
  '语音通话'
]

/** 英文词按词边界匹配——纯 includes 会让 'meet' 命中 'Meetup'、'teams' 命中 'Steams'。 */
function nameHasTerm(name: string, term: string): boolean {
  if (name === term) return true
  if (/^[a-z0-9 ]+$/.test(term)) return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(name)
  return name.includes(term)
}

/**
 * 当前前台像不像一场会。
 *
 * 浏览器和 IM（飞书/微信/钉钉）平时也在前台，只看应用名会一整天都在录，
 * 所以这些走「必须窗口标题也像开会」的严格分支。Zoom/腾讯会议这类专用会议应用
 * 开着就基本是在开会，标题不作要求。
 */
export function meetingAppKind(
  appName: string | null,
  bundleId: string | null,
  windowTitle: string | null
): MeetingAppKind {
  const bundle = (bundleId ?? '').trim().toLowerCase()
  const name = (appName ?? '').trim().toLowerCase()
  const title = (windowTitle ?? '').trim().toLowerCase()
  const titleLooksLikeMeeting = MEETING_TITLE_HINTS.some((h) => title.includes(h))
  // 浏览器与 IM：只有标题也像开会才算，否则整天挂着微信就会一直录
  const needsTitle =
    bundle === 'com.google.chrome' ||
    bundle === 'com.apple.safari' ||
    bundle === 'com.bytedance.lark' ||
    bundle === 'com.electron.lark' ||
    bundle === 'com.alibaba.dingtalk' ||
    bundle === 'com.tencent.xinwechat'

  const byBundle = bundle ? MEETING_BUNDLES[bundle] : undefined
  if (byBundle) return needsTitle && !titleLooksLikeMeeting ? null : byBundle
  if (!name) return titleLooksLikeMeeting ? 'conference' : null
  for (const [terms, kind] of MEETING_NAMES) {
    if (terms.some((t) => nameHasTerm(name, t))) return kind
  }
  return titleLooksLikeMeeting ? 'conference' : null
}

// ---------- 采集与切段 ----------

/** 转录端统一吃 16kHz 单声道 16bit PCM（whisper 系模型的原生输入，省一次重采样）。 */
export const SAMPLE_RATE = 16000

/** 低于这个能量算静音。归一化到 [0,1] 的 RMS，经验值，太高会把轻声说话当静音。 */
export const SILENCE_RMS = 0.012
/** 连续静音多久算一段说完了。太短会把句间换气也切开，太长则迟迟出不来结果。 */
export const SILENCE_CUT_MS = 900
/** 一段最短多久才值得送去转录——低于这个基本是咳嗽、鼠标声。 */
export const MIN_SEGMENT_MS = 1200
/** 一段最长多久必须强制切：有人一口气讲十分钟时，不能等他停。 */
export const MAX_SEGMENT_MS = 25_000

export interface SegmentState {
  /** 本段已录制的毫秒数 */
  durationMs: number
  /** 当前连续静音的毫秒数 */
  silenceMs: number
  /** 本段是否出现过有效人声（全程静音的段直接丢弃，不送转录） */
  hasVoice: boolean
}

export type CutReason = 'silence' | 'maxlen' | null

/**
 * 该不该把当前这段切下来送去转录。
 *
 * 停顿处切开而不是按固定窗口切（借鉴 whisper-flow）：一句话被拦腰截断时，
 * 转录模型两边都拿不到完整语义，错字率明显上升。
 */
export function segmentCut(state: SegmentState): CutReason {
  if (!state.hasVoice) return null // 一直没人说话，继续等，不产生空段
  if (state.durationMs >= MAX_SEGMENT_MS) return 'maxlen'
  if (state.silenceMs >= SILENCE_CUT_MS && state.durationMs >= MIN_SEGMENT_MS) return 'silence'
  return null
}

/** 一帧音频是不是静音。 */
export function isSilent(rms: number): boolean {
  return rms < SILENCE_RMS
}

/** 16bit PCM 帧的归一化 RMS。 */
export function frameRms(samples: Float32Array | number[]): number {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

// ---------- 转录请求的纯逻辑 ----------

/** base 可能填成 https://x.com、https://x.com/、https://x.com/v1，统一收敛到转录端点。 */
export function transcriptionEndpoint(apiBase: string): string {
  const base = apiBase.trim().replace(/\/+$/, '')
  if (/\/audio\/transcriptions$/.test(base)) return base
  if (/\/v\d+$/.test(base)) return `${base}/audio/transcriptions`
  return `${base}/v1/audio/transcriptions`
}

/** WAV 头的字节数，固定 44。 */
export const WAV_HEADER_BYTES = 44

/**
 * 16bit 单声道 PCM 裸数据套上 WAV 头。
 *
 * 转录接口按扩展名和 magic 判格式，裸 PCM 会被拒；WAV 头只有 44 字节，
 * 比在渲染层引一个 mp3/opus 编码器省事得多，也不损音质。
 * 传 Uint8Array 而不是 Buffer，好让这段逻辑在渲染层和测试里都能跑。
 */
export function pcmToWavBytes(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM 子块大小
  view.setUint16(20, 1, true) // 格式 = PCM
  view.setUint16(22, 1, true) // 声道数
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byteRate = 采样率 * 单声道 * 16bit
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // 位深
  ascii(36, 'data')
  view.setUint32(40, pcm.length, true)
  out.set(pcm, WAV_HEADER_BYTES)
  return out
}

// ---------- 解析上下文 ----------

export interface RecentWorkBrief {
  content: string
  task: string | null
}

/**
 * 「用户最近在干什么」上下文块。
 *
 * 会议纪要里最难判的就是归属：「这个下周之前搞定」——谁搞定？光看转录文本没法判。
 * 把用户近期的工作记录喂进去，模型才能把「你一直在做的那条线」和会上分给你的活对上号。
 * 条数刻意收紧：给太多会把模型的注意力从转录本身带偏。
 */
export function recentWorkBlock(records: readonly RecentWorkBrief[], limit = 12): string {
  const lines = records
    .map((r) => (r.task ? `- ${r.task}：${r.content}` : `- ${r.content}`))
    .filter((l) => l.length > 3)
    .slice(0, limit)
  if (!lines.length) return ''
  return `\n# 用户最近在做的事（来自本机工作记录，用于判断会上哪些活是他的）\n${lines.join('\n')}\n`
}

/** 渲染层送到主进程的一段 PCM。走 base64 而不是 ArrayBuffer——
 *  IPC 的 structured clone 对 TypedArray 有坑，字符串最省心，也便于日志里看长度。 */
export interface PcmSegment {
  sessionId: string
  seq: number
  durationMs: number
  /** 16bit LE 单声道 PCM 的 base64 */
  pcmBase64: string
}

/** 会话状态。finalizing 是「录完了正在转录/解析」，UI 靠它显示进度。 */
export type VoiceSessionStatus = 'recording' | 'finalizing' | 'done' | 'failed'

export interface VoiceSessionRecord {
  id: string
  /** 触发录制的应用名，手动开始时为 null */
  app: string | null
  startedAt: string
  endedAt: string | null
  status: VoiceSessionStatus
  /** 已转录出的全文（分段累加） */
  transcript: string
  /** 解析出并入库的任务数；未解析时为 0 */
  taskCount: number
}
