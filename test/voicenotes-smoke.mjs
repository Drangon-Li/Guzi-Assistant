// 纯函数单测：语音纪要的会议识别、按停顿切段、解析上下文块。
// 运行：node test/run.mjs voicenotes
import {
  frameRms,
  pcmToWavBytes,
  transcriptionEndpoint,
  WAV_HEADER_BYTES,
  SAMPLE_RATE,
  isSilent,
  MAX_SEGMENT_MS,
  meetingAppKind,
  MIN_SEGMENT_MS,
  recentWorkBlock,
  segmentCut,
  SILENCE_CUT_MS,
  SILENCE_RMS
} from '../src/shared/voicenotes.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- 会议应用识别 ----
check('Zoom 开着就算在开会', meetingAppKind('zoom.us', 'us.zoom.xos', '') === 'conference')
check('腾讯会议按 bundleId 认', meetingAppKind(null, 'com.tencent.meeting', '') === 'conference')
check('FaceTime 算通话', meetingAppKind('FaceTime', 'com.apple.facetime', '') === 'call')
check(
  'Teams 按名字兜底',
  meetingAppKind('Microsoft Teams', 'com.unknown.fork', '') === 'conference'
)

// 浏览器 / IM 必须窗口标题也像开会，否则整天挂着会一直录
check(
  '浏览器开着普通网页 → 不算',
  meetingAppKind('Google Chrome', 'com.google.chrome', 'GitHub - 某个仓库') === null
)
check(
  '浏览器开着 Google Meet → 算',
  meetingAppKind('Google Chrome', 'com.google.chrome', '会议 - meet.google.com') === 'conference'
)
check(
  '微信平时聊天 → 不算',
  meetingAppKind('微信', 'com.tencent.xinwechat', '张三') === null
)
check(
  '微信语音通话 → 算',
  meetingAppKind('微信', 'com.tencent.xinwechat', '语音通话中') === 'call'
)
check(
  '飞书日常 IM → 不算',
  meetingAppKind('Lark', 'com.bytedance.lark', '群聊消息') === null
)
check(
  '飞书会议中 → 算',
  meetingAppKind('Lark', 'com.bytedance.lark', '会议中 - 周会') === 'conference'
)

check('无关应用不算', meetingAppKind('Xcode', 'com.apple.dt.Xcode', 'main.swift') === null)
check('全空不算', meetingAppKind(null, null, null) === null)
check('词边界：Meetup 不算会议', meetingAppKind('Meetup', 'com.unknown.meetup', '') === null)
check(
  '只有标题像开会也认（拿不到 bundleId 时）',
  meetingAppKind(null, null, '正在会议') === 'conference'
)

// ---- 切段：按停顿切，不按固定窗口 ----
const st = (durationMs, silenceMs, hasVoice = true) => ({ durationMs, silenceMs, hasVoice })

check('全程没人说话 → 不产生空段', segmentCut(st(30_000, 30_000, false)) === null)
check(
  '停顿够长且时长达标 → 按停顿切',
  segmentCut(st(MIN_SEGMENT_MS + 100, SILENCE_CUT_MS)) === 'silence'
)
check(
  '停顿够长但太短 → 不切（咳嗽/鼠标声）',
  segmentCut(st(MIN_SEGMENT_MS - 100, SILENCE_CUT_MS)) === null
)
check('说话中途不切', segmentCut(st(10_000, 0)) === null)
check(
  '一口气讲太久 → 强制切',
  segmentCut(st(MAX_SEGMENT_MS, 0)) === 'maxlen'
)
check(
  '强制切优先于静音判定',
  segmentCut(st(MAX_SEGMENT_MS + 5_000, SILENCE_CUT_MS)) === 'maxlen'
)
check('最长上限大于最短门槛', MAX_SEGMENT_MS > MIN_SEGMENT_MS)

// ---- 能量 VAD ----
check('全零帧算静音', isSilent(frameRms(new Float32Array(128))))
check('空帧 RMS 为 0', frameRms([]) === 0)
check('满幅帧不算静音', !isSilent(frameRms([1, -1, 1, -1])))
check('RMS 算得对', Math.abs(frameRms([0.5, -0.5]) - 0.5) < 1e-9)
check('阈值本身算静音（严格小于）', !isSilent(SILENCE_RMS))

// ---- 解析上下文 ----
check('没有工作记录 → 空块，不往提示词里塞噪声', recentWorkBlock([]) === '')
const block = recentWorkBlock([
  { content: '调 detection 的入队门槛', task: '谷子助手' },
  { content: '写周报', task: null }
])
check('带任务名的记录格式化成「任务：内容」', block.includes('- 谷子助手：调 detection 的入队门槛'))
check('无任务名的只留内容', block.includes('- 写周报'))
check('块里点明用途是判归属', block.includes('哪些活是他的'))
check(
  '条数收紧到 limit',
  recentWorkBlock(
    Array.from({ length: 50 }, (_, i) => ({ content: `事项${i}`, task: null })),
    5
  ).split('\n').filter((l) => l.startsWith('- ')).length === 5
)
check(
  '过短的记录被丢掉',
  !recentWorkBlock([{ content: 'a', task: null }, { content: '正经的一条记录', task: null }]).includes('- a\n')
)

// ---- 转录端点归一化 ----
const ep = transcriptionEndpoint
check('裸域名补全路径', ep('https://x.com') === 'https://x.com/v1/audio/transcriptions')
check('结尾斜杠不产生双斜杠', ep('https://x.com/') === 'https://x.com/v1/audio/transcriptions')
check('已带 /v1 只补后半段', ep('https://x.com/v1') === 'https://x.com/v1/audio/transcriptions')
check('自定义版本号也认', ep('https://x.com/v2') === 'https://x.com/v2/audio/transcriptions')
check('已是完整端点则原样', ep('https://x.com/v1/audio/transcriptions') === 'https://x.com/v1/audio/transcriptions')
check('前后空格被裁掉', ep('  https://x.com  ') === 'https://x.com/v1/audio/transcriptions')

// ---- WAV 头 ----
const pcm = new Uint8Array(1000)
const wav = pcmToWavBytes(pcm)
const txt = (bytes, at, len) => String.fromCharCode(...bytes.subarray(at, at + len))
const u32 = (bytes, at) => new DataView(bytes.buffer).getUint32(at, true)
const u16 = (bytes, at) => new DataView(bytes.buffer).getUint16(at, true)
check('总长 = 头 + 数据', wav.length === WAV_HEADER_BYTES + pcm.length)
check('RIFF magic', txt(wav, 0, 4) === 'RIFF')
check('WAVE magic', txt(wav, 8, 4) === 'WAVE')
check('data 块标识', txt(wav, 36, 4) === 'data')
check('RIFF 长度字段 = 36 + 数据', u32(wav, 4) === 36 + pcm.length)
check('data 长度字段 = 数据长度', u32(wav, 40) === pcm.length)
check('格式为 PCM', u16(wav, 20) === 1)
check('单声道', u16(wav, 22) === 1)
check('采样率 16k', u32(wav, 24) === SAMPLE_RATE)
check('byteRate = 采样率 * 2', u32(wav, 28) === SAMPLE_RATE * 2)
check('位深 16', u16(wav, 34) === 16)
check('PCM 数据被原样附在头后面', pcmToWavBytes(new Uint8Array([1, 2, 3, 4]))[WAV_HEADER_BYTES] === 1)
check('空 PCM 也能产出合法头', pcmToWavBytes(new Uint8Array(0)).length === WAV_HEADER_BYTES)

// ---- 转录请求形状：起一个本地假端点，验证发出去的 multipart 长什么样 ----
// 不联网，只验证「我们构造的请求」是否符合 OpenAI 兼容转录接口的约定。
const { createServer } = await import('node:http')
let seen = null
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const text = body.toString('latin1')
    seen = {
      url: req.url,
      method: req.method,
      auth: req.headers.authorization,
      contentType: req.headers['content-type'] ?? '',
      model: (text.match(/name="model"\r\n\r\n([^\r]+)/) ?? [])[1],
      format: (text.match(/name="response_format"\r\n\r\n([^\r]+)/) ?? [])[1],
      filename: (text.match(/filename="([^"]+)"/) ?? [])[1],
      hasRiff: body.includes('RIFF')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: '明天下午三点开评审会。' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const apiBase = `http://127.0.0.1:${server.address().port}`

// 一秒 440Hz 正弦，当作「有声音」的 PCM
const samples = new Uint8Array(SAMPLE_RATE * 2)
const dv = new DataView(samples.buffer)
for (let i = 0; i < SAMPLE_RATE; i += 1) {
  dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0x4000), true)
}
const form = new FormData()
form.append('file', new Blob([pcmToWavBytes(samples)], { type: 'audio/wav' }), 'segment.wav')
form.append('model', 'gpt-4o-mini-transcribe')
form.append('response_format', 'json')
const res = await fetch(transcriptionEndpoint(apiBase), {
  method: 'POST',
  headers: { Authorization: 'Bearer sk-test' },
  body: form
})
const parsed = await res.json()
server.close()

check('请求打到 /v1/audio/transcriptions', seen?.url === '/v1/audio/transcriptions')
check('用 POST', seen?.method === 'POST')
check('带 Bearer 鉴权头', seen?.auth === 'Bearer sk-test')
check('走 multipart 编码', seen?.contentType.startsWith('multipart/form-data'))
check('model 字段传对', seen?.model === 'gpt-4o-mini-transcribe')
check('response_format 为 json', seen?.format === 'json')
check('文件名带扩展名（服务端按它判格式）', seen?.filename === 'segment.wav')
check('音频体是 WAV', seen?.hasRiff === true)
check('能解析出 text', parsed.text === '明天下午三点开评审会。')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
