import {
  resolveDirectModelSettings,
  responsesEndpoint
} from '../src/shared/model-configuration.ts'

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

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
