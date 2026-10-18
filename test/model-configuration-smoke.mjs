import { resolveDirectModelSettings, responsesEndpoint, modelsEndpoint, parseModelList, modelForAction } from '../src/shared/model-configuration.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const allEnv = {
  GUZI_ASSISTANT_API_BASE: 'https://guzi.example/v1',
  GUZI_ASSISTANT_API_KEY: 'guzi-key',
  GUZI_ASSISTANT_MODEL: 'guzi-model',
  OPENAI_BASE_URL: 'https://openai.example/v1',
  OPENAI_API_KEY: 'openai-key',
  OPENAI_MODEL: 'openai-model',
  ESHELL_API_BASE: 'https://eshell.example/v1',
  ESHELL_API_KEY: 'eshell-key',
  ESHELL_MODEL: 'eshell-model'
}

const guziFirst = resolveDirectModelSettings({}, allEnv)
check(
  'GUZI_ASSISTANT_* 优先于 OPENAI_* 和 ESHELL_*',
  guziFirst.apiBase === 'https://guzi.example/v1' &&
    guziFirst.apiKey === 'guzi-key' &&
    guziFirst.model === 'guzi-model'
)

const openAiFallback = resolveDirectModelSettings({}, {
  ...allEnv,
  GUZI_ASSISTANT_API_BASE: ' ',
  GUZI_ASSISTANT_API_KEY: '',
  GUZI_ASSISTANT_MODEL: undefined
})
check(
  'GUZI_ASSISTANT_* 为空时回退 OPENAI_*',
  openAiFallback.apiBase === 'https://openai.example/v1' &&
    openAiFallback.apiKey === 'openai-key' &&
    openAiFallback.model === 'openai-model'
)

const eshellFallback = resolveDirectModelSettings({}, {
  ESHELL_API_BASE: 'https://eshell.example/v1',
  ESHELL_API_KEY: 'eshell-key',
  ESHELL_MODEL: 'eshell-model'
})
check(
  'OPENAI_* 缺失时回退 ESHELL_*',
  eshellFallback.apiBase === 'https://eshell.example/v1' &&
    eshellFallback.apiKey === 'eshell-key' &&
    eshellFallback.model === 'eshell-model'
)

const storedFirst = resolveDirectModelSettings(
  { apiBase: 'https://stored.example/v1', apiKey: 'stored-key', model: 'stored-model' },
  allEnv
)
check(
  '数据库显式设置优先于所有环境变量',
  storedFirst.apiBase === 'https://stored.example/v1' &&
    storedFirst.apiKey === 'stored-key' &&
    storedFirst.model === 'stored-model'
)

const storedCleared = resolveDirectModelSettings({ apiBase: '', apiKey: '', model: '' }, allEnv)
check(
  '数据库显式清空后不从环境变量复活',
  storedCleared.apiBase === '' && storedCleared.apiKey === '' && storedCleared.model === ''
)

const defaults = resolveDirectModelSettings({}, {})
check(
  '无配置时仅模型使用默认值',
  defaults.apiBase === '' && defaults.apiKey === '' && defaults.model === 'gpt-5.5'
)

check(
  'base 已含 /v1 时不重复追加',
  responsesEndpoint('https://host.example/qwen/v1') ===
    'https://host.example/qwen/v1/responses'
)
check(
  '尾随斜杠会先规整',
  responsesEndpoint('https://host.example/qwen/v1///') ===
    'https://host.example/qwen/v1/responses'
)
check(
  'base 不含 /v1 时自动追加',
  responsesEndpoint('https://host.example/qwen') ===
    'https://host.example/qwen/v1/responses'
)

// ---- 模型列表端点 ----
check('models 端点自动补 /v1', modelsEndpoint('https://api.openai.com') === 'https://api.openai.com/v1/models')
check('models 端点不重复补 /v1', modelsEndpoint('https://host.example/qwen/v1') === 'https://host.example/qwen/v1/models')
check('models 端点规整尾随斜杠', modelsEndpoint('https://host.example/v1///') === 'https://host.example/v1/models')
check('models 端点去首尾空格', modelsEndpoint('  https://a.b  ') === 'https://a.b/v1/models')
check('responses 保留火山 coding /v3', responsesEndpoint('https://ark.cn-beijing.volces.com/api/coding/v3') === 'https://ark.cn-beijing.volces.com/api/coding/v3/responses')
check('models 保留火山 coding /v3', modelsEndpoint('https://ark.cn-beijing.volces.com/api/coding/v3') === 'https://ark.cn-beijing.volces.com/api/coding/v3/models')
check('完整 responses 端点不重复追加', responsesEndpoint('https://host.example/v2/responses') === 'https://host.example/v2/responses')
check('从完整 chat 端点生成 models', modelsEndpoint('https://host.example/v2/chat/completions') === 'https://host.example/v2/models')
check('从完整 messages 端点生成 models', modelsEndpoint('https://host.example/anthropic/v3/messages/') === 'https://host.example/anthropic/v3/models')
check('完整 models 端点不重复追加', modelsEndpoint('https://host.example/v3/models') === 'https://host.example/v3/models')

// ---- 模型列表解析（各家兼容程度不一，只认 id）----
check(
  '标准 {data:[{id}]} 形态',
  JSON.stringify(parseModelList({ data: [{ id: 'gpt-4' }, { id: 'gpt-3.5' }] })) === '["gpt-3.5","gpt-4"]'
)
check('去重', JSON.stringify(parseModelList({ data: [{ id: 'a' }, { id: 'a' }] })) === '["a"]')
check('裸数组也认', JSON.stringify(parseModelList([{ id: 'b' }, { id: 'a' }])) === '["a","b"]')
check('字符串数组也认', JSON.stringify(parseModelList(['b', 'a'])) === '["a","b"]')
check('空/异常输入 → 空列表', parseModelList(null).length === 0 && parseModelList({ data: 'x' }).length === 0)
check('忽略没有 id 的项', JSON.stringify(parseModelList({ data: [{ id: 'a' }, { name: 'b' }, {}] })) === '["a"]')
check('忽略空白 id', JSON.stringify(parseModelList({ data: [{ id: '  ' }, { id: 'a' }] })) === '["a"]')

// ---- 模型分档 ----
const tiers = { model: 'text-m', modelVision: 'vision-m', modelChat: 'chat-m' }
check('文本抽取用文本档', modelForAction('parse_text', tiers) === 'text-m')
check('读图用读图档', modelForAction('parse_vision', tiers) === 'vision-m')
check('对话用对话档', modelForAction('chat', tiers) === 'chat-m')

const only = { model: 'text-m', modelVision: '', modelChat: '' }
check('读图档留空 → 回落文本档', modelForAction('parse_vision', only) === 'text-m')
check('对话档留空 → 回落文本档', modelForAction('chat', only) === 'text-m')
check(
  '只填空白也算留空',
  modelForAction('parse_vision', { model: 'text-m', modelVision: '   ', modelChat: '' }) === 'text-m'
)
check('各档去首尾空格', modelForAction('chat', { model: 'a', modelVision: '', modelChat: '  c  ' }) === 'c')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
