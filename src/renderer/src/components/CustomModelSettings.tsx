import { useEffect, useState } from 'react'
import type { ModelProbeResult } from '@shared/model-configuration'
import { api } from '../api'
import { API_FORMATS, chatEndpoint, normalizeApiFormat, type ApiFormat } from '@shared/api-formats'
import { Toggle } from './ui'

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none'

type Status =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; count: number; responsesAvailable: boolean | null }
  | { kind: 'fail'; message: string }

/** 设置页「自定义模型」分区：填自己的 OpenAI 兼容 API，检测连通性并选模型。 */
export default function CustomModelSettings(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [apiFormat, setApiFormat] = useState<ApiFormat>('openai-responses')
  const [apiBase, setApiBase] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [modelVision, setModelVision] = useState('')
  const [modelChat, setModelChat] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  // 接口没列全时用户仍需要手填（列表是辅助，不是牢笼）
  const [manual, setManual] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    void api.getSettings().then((s) => {
      setEnabled(s.useCustomModel)
      setApiFormat(normalizeApiFormat(s.apiFormat))
      setApiBase(s.apiBase)
      setApiKey(s.apiKey)
      setModel(s.model)
      setModelVision(s.modelVision)
      setModelChat(s.modelChat)
    })
  }, [])

  const probe = async (): Promise<void> => {
    setStatus({ kind: 'probing' })
    let result: ModelProbeResult
    try {
      result = await api.probeModel(apiBase, apiKey, apiFormat)
    } catch (e) {
      setStatus({ kind: 'fail', message: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!result.ok) {
      setModels([])
      setStatus({ kind: 'fail', message: result.error ?? '检测失败' })
      return
    }
    setModels(result.models)
    setManual(false)
    setStatus({
      kind: 'ok',
      count: result.models.length,
      responsesAvailable: result.responsesAvailable
    })
    // 探测成功顺带把地址和 Key 存下来，省得用户还要额外点一次别处才生效
    await api.saveSettings({ apiBase: apiBase.trim(), apiKey: apiKey.trim(), apiFormat })
  }

  const tiers = [
    {
      key: 'model' as const,
      label: '文本抽取',
      hint: '剪贴板、屏幕感知、文本解析。用得最频繁，选快的',
      value: model,
      set: setModel,
      placeholder: 'gpt-5.5'
    },
    {
      key: 'modelVision' as const,
      label: '读图',
      hint: '截图和图片解析。必须是多模态模型，留空则沿用文本档',
      value: modelVision,
      set: setModelVision,
      placeholder: '留空 = 跟随文本抽取'
    },
    {
      key: 'modelChat' as const,
      label: '助手对话',
      hint: '右下角悬浮助手。留空则沿用文本档',
      value: modelChat,
      set: setModelChat,
      placeholder: '留空 = 跟随文本抽取'
    }
  ]

  const choose = async (key: 'model' | 'modelVision' | 'modelChat', next: string): Promise<void> => {
    tiers.find((t) => t.key === key)?.set(next)
    await api.saveSettings({ [key]: next })
  }

  // 只取路径部分给提示用：地址还没填时 chatEndpoint 会拼出个半截 URL，展示全量反而更迷惑
  const endpointPath = chatEndpoint('', apiFormat).replace(/^\/+/, '/')

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-slate-500">接口格式</span>
        <select
          className={input}
          value={apiFormat}
          onChange={(e) => {
            const next = normalizeApiFormat(e.target.value)
            setApiFormat(next)
            setStatus({ kind: 'idle' }) // 换了协议，上次的检测结论不再作数
            void api.saveSettings({ apiFormat: next })
          }}
        >
          {API_FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-400">
          {API_FORMATS.find((f) => f.value === apiFormat)?.hint}
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-slate-500">API 地址</span>
        <input
          className={input}
          placeholder="https://api.openai.com/v1"
          value={apiBase}
          onChange={(e) => setApiBase(e.target.value)}
          onBlur={() => void api.saveSettings({ apiBase: apiBase.trim() })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-slate-500">API Key</span>
        <div className="flex gap-2">
          <input
            className={input}
            type={showKey ? 'text' : 'password'}
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={() => void api.saveSettings({ apiKey: apiKey.trim() })}
          />
          <button
            className="shrink-0 rounded-lg border border-slate-300 px-3 text-xs text-slate-500 hover:bg-slate-50"
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </label>

      <div className="flex items-center gap-2">
        <button
          className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
          disabled={status.kind === 'probing'}
          onClick={() => void probe()}
        >
          {status.kind === 'probing' ? '检测中…' : '检测连接并获取模型'}
        </button>
        {status.kind === 'ok' && (
          <span className="text-xs text-emerald-600">
            {status.count ? `连接正常，发现 ${status.count} 个模型` : '连接正常，但接口未返回模型列表'}
          </span>
        )}
        {status.kind === 'fail' && <span className="text-xs text-amber-600">{status.message}</span>}
      </div>

      {status.kind === 'ok' && status.responsesAvailable === false && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
          Key 和模型列表都正常，但该服务没有提供 <code>{endpointPath}</code>——
          按当前的「{API_FORMATS.find((f) => f.value === apiFormat)?.label}」格式启用后解析会失败。
          {apiFormat === 'openai-responses' && '多数第三方「OpenAI 兼容」服务只实现了 Chat Completions，换成上面的「OpenAI 兼容 (Chat)」再试。'}
          {apiFormat === 'anthropic' && '确认这个地址确实是 Claude 官方或兼容 Anthropic 协议的服务。'}
          {apiFormat === 'openai-chat' && '确认地址填的是服务根地址（不要带 /chat/completions）。'}
        </div>
      )}
      {status.kind === 'ok' && status.responsesAvailable === null && (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          没能确认 <code>{endpointPath}</code> 是否可用（网络原因），启用后如果解析报错，多半是这个原因。
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-slate-200 pt-3">
        <div className="text-xs text-slate-400">
          三类调用需求不同，可分别指定；只填「文本抽取」也能用。
          {models.length > 0 && (
            <button
              className="ml-2 text-brand hover:underline"
              onClick={() => setManual(!manual)}
            >
              {manual ? '回到列表选择' : '改为手动填写'}
            </button>
          )}
        </div>
        {tiers.map((tier) => (
          <label key={tier.key} className="flex flex-col gap-1">
            <span className="text-slate-500">
              {tier.label}
              <span className="ml-2 text-xs text-slate-400">{tier.hint}</span>
            </span>
            {models.length > 0 && !manual ? (
              <select
                className={input}
                value={tier.value}
                onChange={(e) => void choose(tier.key, e.target.value)}
              >
                {tier.key !== 'model' && <option value="">（跟随文本抽取）</option>}
                {/* 已存的模型可能不在本次返回的列表里（换了服务商 / 接口没列全），单独保留一项 */}
                {tier.value && !models.includes(tier.value) && (
                  <option value={tier.value}>{tier.value}（当前）</option>
                )}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={input}
                placeholder={tier.placeholder}
                value={tier.value}
                onChange={(e) => tier.set(e.target.value)}
                onBlur={() => void api.saveSettings({ [tier.key]: tier.value.trim() })}
              />
            )}
          </label>
        ))}
      </div>

      <label className="flex items-center justify-between gap-4 border-t border-slate-200 pt-3">
        <span>
          启用自定义模型
          <span className="ml-2 text-xs text-slate-400">
            开启后解析优先走你自己的 API，不再消耗内置服务的积分
          </span>
        </span>
        <Toggle
          checked={enabled}
          ariaLabel="启用自定义模型"
          onChange={(next) => {
            setEnabled(next)
            void api.saveSettings({ useCustomModel: next })
          }}
        />
      </label>

      <p className="text-xs text-slate-400">
        需要 OpenAI 兼容接口（解析走 <code>/v1/responses</code>，模型列表走 <code>/v1/models</code>）。
        检测会顺带确认 <code>/v1/responses</code> 是否存在，但不会真的发起推理，因此不消耗你的额度。
      </p>
    </div>
  )
}
