import assert from 'node:assert/strict'
import { createModelClient } from '../src/main/model-client.ts'

let failed = 0
async function test(name, run) {
  try {
    await run()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`✗ ${name}\n  ${error.stack ?? error}`)
  }
}

const config = { apiBase: 'https://gateway.example/v1', apiKey: 'test-key', model: 'test-model', apiFormat: 'auto' }
const req = { instructions: 'Answer briefly', input: [{ role: 'user', content: 'hello' }] }
const payloads = {
  'openai-chat': { choices: [{ message: { content: 'hello' } }] },
  'openai-responses': { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] },
  anthropic: { content: [{ type: 'text', text: 'hello' }] }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const routeMissing = () => json({ error: { message: 'Route not found' } }, 404)
const success = (format) => json(payloads[format])

function mockClient(steps) {
  const calls = []
  const fetcher = async (url, init = {}) => {
    const call = { url: String(url), ...init, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const next = steps.shift()
    assert.ok(next, `Unexpected request: ${call.method ?? 'GET'} ${call.url}`)
    return typeof next === 'function' ? await next(call) : next
  }
  const client = createModelClient(fetcher)
  return {
    client: {
      ...client,
      request: (settings, request, signal = new AbortController().signal) => client.request(settings, request, signal)
    },
    calls,
    done: () => assert.equal(steps.length, 0, 'Unused mock responses')
  }
}

await test('火山 coding/v3 先用 Responses，完整路径与 key 保留在同一主机', async () => {
  const m = mockClient([success('openai-responses')])
  const result = await m.client.request({ ...config, apiBase: 'https://ark.cn-beijing.volces.com/api/coding/v3' }, req)
  assert.deepEqual(result, { text: 'hello', format: 'openai-responses' })
  assert.equal(m.calls[0].url, 'https://ark.cn-beijing.volces.com/api/coding/v3/responses')
  assert.equal(m.calls[0].headers.Authorization, 'Bearer test-key')
  assert.equal(m.calls[0].redirect, 'error')
  assert.equal(m.calls[0].method, 'POST')
  m.done()
})

await test('完整 messages 路径优先且使用 Anthropic 请求体与认证', async () => {
  const m = mockClient([success('anthropic')])
  const result = await m.client.request({ ...config, apiBase: 'https://gateway.example/anthropic/v3/messages' }, req)
  assert.equal(result.format, 'anthropic')
  assert.equal(m.calls[0].url, 'https://gateway.example/anthropic/v3/messages')
  assert.equal(m.calls[0].headers['x-api-key'], 'test-key')
  assert.equal(m.calls[0].headers.Authorization, undefined)
  assert.equal(m.calls[0].body.system, req.instructions)
  m.done()
})

await test('明确路由 404 后回退 Responses，成功协议进入缓存', async () => {
  const m = mockClient([routeMissing(), success('openai-responses'), success('openai-responses')])
  assert.equal((await m.client.request(config, req)).format, 'openai-responses')
  assert.equal((await m.client.request(config, req)).format, 'openai-responses')
  assert.deepEqual(m.calls.map((c) => c.url), [
    'https://gateway.example/v1/chat/completions',
    'https://gateway.example/v1/responses',
    'https://gateway.example/v1/responses'
  ])
  m.done()
})

await test('缓存按 base、key、model 隔离，不根据 key 或模型名称猜协议', async () => {
  const m = mockClient([
    routeMissing(), success('openai-responses'),
    success('openai-chat'), success('openai-chat'), success('openai-chat'),
    success('openai-responses')
  ])
  await m.client.request(config, req)
  await m.client.request({ ...config, apiKey: 'sk-ant-another-key' }, req)
  await m.client.request({ ...config, model: 'claude-another-model' }, req)
  await m.client.request({ ...config, apiBase: 'https://another.example/v1' }, req)
  await m.client.request(config, req)
  assert.deepEqual(m.calls.map((c) => new URL(c.url).pathname), [
    '/v1/chat/completions', '/v1/responses', '/v1/chat/completions', '/v1/chat/completions',
    '/v1/chat/completions', '/v1/responses'
  ])
  m.done()
})

await test('失败不写缓存，下次从 URL 默认候选重试', async () => {
  const m = mockClient([routeMissing(), json({ error: { message: 'temporarily unavailable' } }, 503), success('openai-chat')])
  await assert.rejects(m.client.request(config, req))
  assert.equal((await m.client.request(config, req)).format, 'openai-chat')
  assert.equal(m.calls[2].url, 'https://gateway.example/v1/chat/completions')
  m.done()
})

await test('手动协议优先于 URL 及缓存，失败不会自动切换', async () => {
  const m = mockClient([routeMissing(), success('openai-responses'), success('anthropic'), routeMissing()])
  await m.client.request(config, req)
  assert.equal((await m.client.request({ ...config, apiFormat: 'anthropic' }, req)).format, 'anthropic')
  await assert.rejects(m.client.request({ ...config, apiFormat: 'openai-chat' }, req))
  assert.equal(m.calls.length, 4)
  assert.equal(m.calls[2].url, 'https://gateway.example/v1/messages')
  m.done()
})

for (const [status, error] of [
  [400, { message: "Unknown field 'messages'; expected input", param: 'messages' }],
  [422, { message: "Field 'input' is required", param: 'input' }],
  [405, { message: 'Method not allowed' }]
]) {
  await test(`明确协议字段不兼容或路由不支持 (${status}) 才切换`, async () => {
    const m = mockClient([json({ error }, status), success('openai-responses')])
    assert.equal((await m.client.request(config, req)).format, 'openai-responses')
    assert.equal(m.calls.length, 2)
    m.done()
  })
}

for (const status of [401, 403, 429, 500, 503]) {
  await test(`${status} 不切换协议且 probe 不误报成功`, async () => {
    const m = mockClient([json({ error: { message: 'request rejected' } }, status)])
    const result = await m.client.probe(config)
    assert.equal(result.ok, false)
    assert.equal(result.detectedFormat, null)
    assert.deepEqual(result.models, [])
    assert.ok(result.error)
    assert.equal(m.calls.length, 1)
    m.done()
  })
}

await test('模型不存在的 404 不被误认成路由错误', async () => {
  const m = mockClient([json({ error: { code: 'model_not_found', message: "The model 'test-model' does not exist" } }, 404)])
  await assert.rejects(m.client.request(config, req))
  assert.equal(m.calls.length, 1)
  m.done()
})

for (const [code, message] of [
  ['DeploymentNotFound', 'The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.'],
  ['ModelNotFound', 'The requested resource is unavailable.']
]) {
  await test(`404 ${code} 不将模型或 Azure 部署缺失当作协议路由错误`, async () => {
    const m = mockClient([json({ error: { code, message } }, 404)])
    await assert.rejects(m.client.request(config, req))
    assert.equal(m.calls.length, 1)
    m.done()
  })
}

for (const [status, body] of [
  [400, {}],
  [404, {}],
  [400, { error: { message: 'messages exceeds the model context length' } }],
  [422, { error: { message: 'Invalid model configuration' } }]
]) {
  await test(`缺少协议证据的 ${status} 不自动尝试其他协议`, async () => {
    const m = mockClient([json(body, status)])
    await assert.rejects(m.client.request(config, req))
    assert.equal(m.calls.length, 1)
    m.done()
  })
}

for (const status of [400, 422]) {
  for (const [code, message] of [
    ['insufficient_quota', 'This endpoint is not supported on your current plan'],
    ['permission_denied', 'This API endpoint is not supported by this API key']
  ]) {
    await test(`${status} ${code} 不因 endpoint unsupported 文案切协议`, async () => {
      const m = mockClient([json({ error: { code, message } }, status)])
      await assert.rejects(m.client.request(config, req))
      assert.equal(m.calls.length, 1)
      m.done()
    })
  }
}

await test('网络异常不回退，也不被 probe 误报成功', async () => {
  const m = mockClient([() => { throw new TypeError('fetch failed') }])
  const result = await m.client.probe(config)
  assert.equal(result.ok, false)
  assert.equal(result.detectedFormat, null)
  assert.equal(m.calls.length, 1)
  m.done()
})

await test('取消信号传给 fetch，取消不回退', async () => {
  const controller = new AbortController()
  const m = mockClient([(call) => {
    assert.equal(call.signal, controller.signal)
    controller.abort()
    throw new DOMException('Cancelled', 'AbortError')
  }])
  await assert.rejects(m.client.request(config, req, controller.signal), (error) => error.name === 'AbortError')
  assert.equal(m.calls.length, 1)
  m.done()
})

await test('重定向被禁止，失败不会将 key 发往其他域名', async () => {
  const m = mockClient([(call) => {
    assert.equal(call.redirect, 'error')
    assert.equal(new URL(call.url).hostname, 'gateway.example')
    throw new TypeError('redirect mode is set to error')
  }])
  await assert.rejects(m.client.request(config, req))
  assert.equal(m.calls.length, 1)
  m.done()
})

for (const [name, makeResponse] of [
  ['HTML', () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })],
  ['空响应', () => new Response('')],
  ['空 JSON', () => json({})],
  ['其他协议 JSON', () => success('anthropic')],
  ['200 error JSON', () => json({ error: { message: 'invalid key' } })]
]) {
  await test(`200 ${name} 不当作成功识别，也不继续猜协议`, async () => {
    const m = mockClient([makeResponse()])
    const result = await m.client.probe(config)
    assert.equal(result.ok, false)
    assert.equal(result.detectedFormat, null)
    assert.deepEqual(result.models, [])
    assert.equal(m.calls.length, 1)
    m.done()
  })
}

await test('probe 先发真实短推理，再返回已验证协议与 models', async () => {
  const m = mockClient([routeMissing(), success('openai-responses'), json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] })])
  const result = await m.client.probe(config)
  assert.deepEqual(result, { ok: true, models: ['a', 'b'], error: null, detectedFormat: 'openai-responses' })
  const posts = m.calls.filter((c) => c.method === 'POST')
  assert.equal(posts.length, 2)
  for (const call of posts) {
    assert.equal(call.body.model, config.model)
    const limit = call.body.max_tokens ?? call.body.max_output_tokens
    assert.ok(limit > 0 && limit <= 64, `Expected short probe, received token limit ${limit}`)
    assert.ok(call.body.input?.length || call.body.messages?.length)
  }
  assert.equal(m.calls[2].method ?? 'GET', 'GET')
  assert.equal(m.calls[2].url, 'https://gateway.example/v1/models')
  assert.ok(m.calls.every((c) => c.redirect === 'error'))
  m.done()
})

for (const [name, response] of [
  ['404', () => json({ error: { message: 'not found' } }, 404)],
  ['403', () => json({ error: { message: 'forbidden' } }, 403)],
  ['网络异常', () => { throw new TypeError('models unavailable') }]
]) {
  await test(`models ${name} 不否定已成功的推理探测`, async () => {
    const m = mockClient([success('openai-chat'), response])
    const result = await m.client.probe(config)
    assert.deepEqual(result, { ok: true, models: [], error: null, detectedFormat: 'openai-chat' })
    assert.equal(m.calls.length, 2)
    m.done()
  })
}

for (const missing of ['apiBase', 'apiKey', 'model']) {
  await test(`probe 缺少 ${missing} 提供明确错误且不请求网络`, async () => {
    const m = mockClient([])
    const result = await m.client.probe({ ...config, [missing]: '  ' })
    assert.equal(result.ok, false)
    assert.equal(result.detectedFormat, null)
    assert.ok(result.error?.trim())
    assert.equal(m.calls.length, 0)
    m.done()
  })
}

await test('密钥错误文案不泄漏完整 key', async () => {
  const secret = 'sk-private-test-secret-123456789'
  const m = mockClient([json({ error: { message: `Incorrect API key provided: ${secret}` } }, 401)])
  const result = await m.client.probe({ ...config, apiKey: secret })
  assert.equal(result.ok, false)
  assert.ok(result.error)
  assert.ok(!result.error.includes(secret))
  m.done()
})

await test('Responses 明确不支持 reasoning 时仅移除 reasoning 重试一次', async () => {
  const m = mockClient([
    json({ error: { message: "Unsupported parameter: 'reasoning'", param: 'reasoning', code: 'unsupported_parameter' } }, 400),
    success('openai-responses')
  ])
  assert.equal((await m.client.request({ ...config, apiFormat: 'openai-responses' }, { ...req, effort: 'none' })).format, 'openai-responses')
  assert.deepEqual(m.calls[0].body.reasoning, { effort: 'none' })
  assert.equal(m.calls[1].body.reasoning, undefined)
  const { reasoning: omitted, ...original } = m.calls[0].body
  assert.deepEqual(m.calls[1].body, original)
  assert.equal(m.calls[0].url, m.calls[1].url)
  m.done()
})

await test('reasoning 重试失败不会无限重复', async () => {
  const error = () => json({ error: { message: "Unsupported parameter: 'reasoning'", param: 'reasoning' } }, 400)
  const m = mockClient([error(), error()])
  await assert.rejects(m.client.request({ ...config, apiFormat: 'openai-responses' }, { ...req, effort: 'none' }))
  assert.equal(m.calls.length, 2)
  m.done()
})

await test('Chat 明确不支持 max_tokens 时仅换 max_completion_tokens 重试', async () => {
  const m = mockClient([
    json({ error: { message: "Unsupported parameter: 'max_tokens'; use max_completion_tokens", param: 'max_tokens' } }, 400),
    success('openai-chat')
  ])
  const result = await m.client.request(config, { ...req, maxOutputTokens: 32 })
  assert.equal(result.format, 'openai-chat')
  assert.equal(m.calls[0].body.max_tokens, 32)
  assert.equal(m.calls[1].body.max_tokens, undefined)
  assert.equal(m.calls[1].body.max_completion_tokens, 32)
  assert.equal(m.calls[0].url, m.calls[1].url)
  m.done()
})

for (const code of ['permission_denied', 'insufficient_quota']) {
  for (const [format, parameter, request] of [
    ['openai-responses', 'reasoning', { ...req, effort: 'none' }],
    ['openai-chat', 'max_tokens', { ...req, maxOutputTokens: 32 }]
  ]) {
    await test(`400 ${code} 不因 ${parameter} unsupported 文案触发参数重试`, async () => {
      const m = mockClient([json({ error: { code, message: `Unsupported parameter: '${parameter}'`, param: parameter } }, 400)])
      await assert.rejects(m.client.request({ ...config, apiFormat: format }, request))
      assert.equal(m.calls.length, 1)
      m.done()
    })
  }
}

for (const [status, message] of [[401, "Unsupported parameter: 'reasoning'"], [400, 'reasoning budget exhausted']]) {
  await test(`reasoning 仅被提及或 ${status} 鉴权失败时不移除参数重试`, async () => {
    const m = mockClient([json({ error: { message } }, status)])
    await assert.rejects(m.client.request({ ...config, apiFormat: 'openai-responses' }, { ...req, effort: 'none' }))
    assert.equal(m.calls.length, 1)
    m.done()
  })
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
