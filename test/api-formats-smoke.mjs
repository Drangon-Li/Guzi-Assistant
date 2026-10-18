// 纯函数单测：自动协议候选顺序及三种接口格式适配。
// 运行：node test/run.mjs api-formats
import {
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_VERSION,
  apiFormatCandidates,
  chatBody,
  chatEndpoint,
  chatError,
  chatHeaders,
  chatText,
  normalizeApiFormat,
  splitDataUrl
} from '../src/shared/api-formats.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const textMsg = [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }]
const imgMsg = [
  {
    role: 'user',
    content: [
      { type: 'input_text', text: '看图' },
      { type: 'input_image', image_url: PNG }
    ]
  }
]

// ---- 格式归一化 ----
check('认得 anthropic', normalizeApiFormat('anthropic') === 'anthropic')
check('认得 openai-chat', normalizeApiFormat('openai-chat') === 'openai-chat')
check('保留显式 responses', normalizeApiFormat('openai-responses') === 'openai-responses')
check('认得 auto', normalizeApiFormat('auto') === 'auto')
check('未知值落回 auto', normalizeApiFormat('乱填') === 'auto')
check('空值落回 auto', normalizeApiFormat(undefined) === 'auto' && normalizeApiFormat('') === 'auto')

// ---- URL 仅用于排列候选，必须继续用真实请求验证 ----
const candidates = (base) => apiFormatCandidates(base).join(',')
const CHAT_FIRST = 'openai-chat,openai-responses,anthropic'
check('未知第三方按 chat → responses → anthropic', candidates('https://gateway.example') === CHAT_FIRST)
check('OpenAI 精确官方主机优先 responses', apiFormatCandidates('https://api.openai.com/v1')[0] === 'openai-responses')
check('OpenAI 后缀冒充主机不获得官方优先级', candidates('https://api.openai.com.evil.example/v1') === CHAT_FIRST)
check('URL 路径中的官方域名不获得官方优先级', candidates('https://gateway.example/api.openai.com') === CHAT_FIRST)
check('火山 coding v3 优先 responses', apiFormatCandidates('https://ark.cn-beijing.volces.com/api/coding/v3')[0] === 'openai-responses')
check('Anthropic 官方主机优先 messages', apiFormatCandidates('https://api.anthropic.com')[0] === 'anthropic')
check('anthropic 路径优先 messages', apiFormatCandidates('https://gateway.example/anthropic')[0] === 'anthropic')
check('完整 responses 路径是强提示', apiFormatCandidates('https://gateway.example/v3/responses')[0] === 'openai-responses')
check('完整 chat 路径优先于 OpenAI 主机提示', apiFormatCandidates('https://api.openai.com/v1/chat/completions')[0] === 'openai-chat')
check('完整 messages 路径优先于火山主机提示', apiFormatCandidates('https://ark.cn-beijing.volces.com/api/coding/v3/messages')[0] === 'anthropic')
check('候选包含且仅包含三种具体协议', [
  'https://gateway.example', 'https://api.openai.com', 'https://api.anthropic.com'
].every((base) => [...apiFormatCandidates(base)].sort().join(',') === 'anthropic,openai-chat,openai-responses'))

// ---- 端点 ----
check('responses 端点', chatEndpoint('https://x.com', 'openai-responses') === 'https://x.com/v1/responses')
check('chat 端点', chatEndpoint('https://x.com', 'openai-chat') === 'https://x.com/v1/chat/completions')
check('anthropic 端点', chatEndpoint('https://x.com', 'anthropic') === 'https://x.com/v1/messages')
check('已带 /v1 不重复拼', chatEndpoint('https://x.com/v1', 'openai-chat') === 'https://x.com/v1/chat/completions')
check('结尾斜杠不产生双斜杠', chatEndpoint('https://x.com/', 'anthropic') === 'https://x.com/v1/messages')
check('火山 /api/coding/v3 保持 v3', chatEndpoint('https://ark.cn-beijing.volces.com/api/coding/v3', 'openai-responses') === 'https://ark.cn-beijing.volces.com/api/coding/v3/responses')
check('完整 chat 端点不重复拼接', chatEndpoint('https://x.com/v2/chat/completions', 'openai-chat') === 'https://x.com/v2/chat/completions')
check('完整 responses 端点可切到 messages', chatEndpoint('https://x.com/v3/responses', 'anthropic') === 'https://x.com/v3/messages')
check('完整 messages 端点可切到 responses', chatEndpoint('https://x.com/v3/messages/', 'openai-responses') === 'https://x.com/v3/responses')

// ---- 请求头 ----
const oaH = chatHeaders('sk-1', 'openai-chat')
check('OpenAI 用 Bearer', oaH.Authorization === 'Bearer sk-1')
check('OpenAI 不带 x-api-key', oaH['x-api-key'] === undefined)
const anH = chatHeaders('sk-2', 'anthropic')
check('Anthropic 用 x-api-key', anH['x-api-key'] === 'sk-2')
check('Anthropic 不带 Bearer', anH.Authorization === undefined)
check('Anthropic 带版本头', anH['anthropic-version'] === ANTHROPIC_VERSION)

// ---- 请求体：responses ----
const rb = chatBody({ model: 'm', instructions: 'SYS', input: textMsg, effort: 'none' }, 'openai-responses')
check('responses 保持 instructions + input 原样', rb.instructions === 'SYS' && rb.input === textMsg)
check('responses 带 reasoning', JSON.stringify(rb.reasoning) === '{"effort":"none"}')
check('responses 短测试 token 上限', chatBody({ model: 'm', instructions: 'S', input: textMsg, maxOutputTokens: 16 }, 'openai-responses').max_output_tokens === 16)
check(
  'responses 不给 effort 时不带 reasoning',
  chatBody({ model: 'm', instructions: 'S', input: textMsg }, 'openai-responses').reasoning === undefined
)

// ---- 请求体：chat completions ----
const cb = chatBody({ model: 'm', instructions: 'SYS', input: textMsg, effort: 'none' }, 'openai-chat')
check('chat 首条是 system', cb.messages[0].role === 'system' && cb.messages[0].content === 'SYS')
check('chat 用户消息跟在后面', cb.messages[1].role === 'user' && cb.messages[1].content === '你好')
check('chat 不带 reasoning（网关多半不认）', cb.reasoning === undefined)
check('chat 短测试 token 上限', chatBody({ model: 'm', instructions: 'S', input: textMsg, maxOutputTokens: 16 }, 'openai-chat').max_tokens === 16)
const cbImg = chatBody({ model: 'm', instructions: 'S', input: imgMsg }, 'openai-chat')
check(
  'chat 图片转成 image_url',
  cbImg.messages[1].content.some((c) => c.type === 'image_url' && c.image_url.url === PNG)
)
check(
  'chat 助手历史保留 assistant 角色',
  chatBody(
    { model: 'm', instructions: 'S', input: [{ role: 'assistant', content: [{ type: 'output_text', text: '嗯' }] }] },
    'openai-chat'
  ).messages[1].role === 'assistant'
)

// ---- 请求体：anthropic ----
const ab = chatBody({ model: 'm', instructions: 'SYS', input: textMsg }, 'anthropic')
check('anthropic system 独立字段', ab.system === 'SYS')
check('anthropic 必须带 max_tokens', ab.max_tokens === ANTHROPIC_MAX_TOKENS)
check('anthropic 短测试 token 上限覆盖默认值', chatBody({ model: 'm', instructions: 'S', input: textMsg, maxOutputTokens: 16 }, 'anthropic').max_tokens === 16)
check('anthropic messages 里没有 system 角色', !ab.messages.some((m) => m.role === 'system'))
check('anthropic 文本段', ab.messages[0].content[0].type === 'text')
const abImg = chatBody({ model: 'm', instructions: 'S', input: imgMsg }, 'anthropic')
const imgPart = abImg.messages[0].content.find((c) => c.type === 'image')
check('anthropic 图片拆成 base64 source', imgPart?.source?.type === 'base64')
check('anthropic 图片带 media_type', imgPart?.source?.media_type === 'image/png')
check('anthropic 图片 data 不含 data: 前缀', imgPart?.source?.data === 'iVBORw0KGgo=')
check(
  'anthropic 丢掉拿不到 base64 的图（远程 URL 会让整条请求 400）',
  chatBody(
    { model: 'm', instructions: 'S', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/a.png' }] }] },
    'anthropic'
  ).messages.length === 0
)
check(
  'anthropic 同角色相邻会合并（要求严格交替）',
  chatBody(
    {
      model: 'm',
      instructions: 'S',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'a' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'b' }] }
      ]
    },
    'anthropic'
  ).messages.length === 1
)
check(
  'anthropic 掐掉开头的 assistant（首条必须是 user）',
  chatBody(
    {
      model: 'm',
      instructions: 'S',
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: '开场白' }] },
        { role: 'user', content: [{ type: 'input_text', text: '问题' }] }
      ]
    },
    'anthropic'
  ).messages[0].role === 'user'
)

// ---- 响应解析 ----
check('responses 取 output_text', chatText({ output_text: 'A' }, 'openai-responses') === 'A')
check(
  'responses 取分段 output',
  chatText(
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'B' }] }] },
    'openai-responses'
  ) === 'B'
)
check('chat 取 choices[0].message.content', chatText({ choices: [{ message: { content: 'C' } }] }, 'openai-chat') === 'C')
check(
  'chat 兼容分段 content',
  chatText({ choices: [{ message: { content: [{ text: 'x' }, { text: 'y' }] } }] }, 'openai-chat') === 'xy'
)
check(
  'anthropic 取 content 里的 text 段',
  chatText({ content: [{ type: 'text', text: 'D' }] }, 'anthropic') === 'D'
)
check(
  'anthropic 跳过非 text 段（如 thinking）',
  chatText({ content: [{ type: 'thinking', text: '想' }, { type: 'text', text: 'E' }] }, 'anthropic') === 'E'
)
check('取不到内容返回空串', chatText({}, 'openai-chat') === '')
check('null 不炸', chatText(null, 'anthropic') === '')

// ---- 错误体 ----
check('取 error.message', chatError({ error: { message: '额度不足' } }) === '额度不足')
check('error 是字符串也认', chatError({ error: '坏了' }) === '坏了')
check('没有 error 返回 null', chatError({ ok: 1 }) === null)

// ---- data URL 拆分 ----
check('拆得出 media_type 和 data', JSON.stringify(splitDataUrl(PNG)) === '{"mediaType":"image/png","data":"iVBORw0KGgo="}')
check('不是 data URL 返回 null', splitDataUrl('https://x/a.png') === null)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
