import { useEffect, useRef, useState } from 'react'
import type { ModelProbeResult } from '@shared/model-configuration'
import type { AppSettings } from '@shared/types'
import { api } from '../api'
import { trackExitSave, useExitParticipant } from '../exit-lifecycle'
import { API_FORMATS, normalizeApiFormat, type ApiFormat } from '@shared/api-formats'
import { Toggle } from './ui'

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none'

type Status =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; count: number; detectedFormat: ModelProbeResult['detectedFormat'] }
  | { kind: 'fail'; message: string }

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 设置页「自定义模型」分区：填自己的 API，检测协议并选模型。 */
export default function CustomModelSettings(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [apiFormat, setApiFormat] = useState<ApiFormat>('auto')
  const [apiBase, setApiBase] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [modelVision, setModelVision] = useState('')
  const [modelChat, setModelChat] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [manual, setManual] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const mounted = useRef(false)
  const generation = useRef(0)
  const probing = useRef(false)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const savedSettings = useRef<Partial<AppSettings>>({})

  useEffect(() => {
    mounted.current = true
    const current = ++generation.current
    void api.getSettings().then((s) => {
      if (!mounted.current || current !== generation.current) return
      savedSettings.current = { useCustomModel: s.useCustomModel, apiFormat: normalizeApiFormat(s.apiFormat), apiBase: s.apiBase, apiKey: s.apiKey, model: s.model, modelVision: s.modelVision, modelChat: s.modelChat }
      setEnabled(s.useCustomModel)
      setApiFormat(normalizeApiFormat(s.apiFormat))
      setApiBase(s.apiBase)
      setApiKey(s.apiKey)
      setModel(s.model)
      setModelVision(s.modelVision)
      setModelChat(s.modelChat)
      setLoading(false)
    }).catch((error: unknown) => {
      if (!mounted.current || current !== generation.current) return
      setStatus({ kind: 'fail', message: `读取设置失败：${errorMessage(error)}` })
      setLoading(false)
    })
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])

  const changed = (): void => {
    generation.current++
    setStatus({ kind: 'idle' })
    setSaveError('')
  }

  // 失焦保存可能先于检测按钮触发；按顺序写入，最后保存本次验证的完整配置。
  const savePatch = (patch: Partial<AppSettings>, isCurrent?: () => boolean): Promise<void> => {
    const pending = saveQueue.current.then(async () => {
      if (isCurrent && !isCurrent()) return
      const saved = await api.saveSettings(patch)
      if (!saved) throw new Error('保存设置失败')
      savedSettings.current = { ...savedSettings.current, ...patch }
    })
    const tracked = trackExitSave(pending, 'custom-model-settings')
    saveQueue.current = tracked.catch(() => {})
    return tracked
  }

  const save = (patch: Partial<AppSettings>): void => {
    if (probing.current) return
    void savePatch(patch).catch((error: unknown) => {
      if (mounted.current) setSaveError(`保存设置失败：${errorMessage(error)}`)
    })
  }

  const probe = async (requestedFormat: ApiFormat): Promise<void> => {
    if (probing.current || loading) return
    probing.current = true
    const current = ++generation.current
    const patch = {
      apiBase: apiBase.trim(),
      apiKey: apiKey.trim(),
      apiFormat: requestedFormat,
      model: model.trim()
    }
    const isCurrent = (): boolean => mounted.current && current === generation.current
    setStatus({ kind: 'probing' })
    setSaveError('')
    setModels([])
    let saving = false
    try {
      const result = await api.probeModel(patch.apiBase, patch.apiKey, requestedFormat, patch.model)
      if (!isCurrent()) return
      if (!result.ok) {
        setStatus({ kind: 'fail', message: result.error ?? '检测失败' })
        return
      }
      saving = true
      await savePatch(patch, isCurrent)
      if (!isCurrent()) return
      setApiFormat(requestedFormat)
      setApiBase(patch.apiBase)
      setApiKey(patch.apiKey)
      setModel(patch.model)
      setModels(result.models)
      setManual(false)
      setStatus({ kind: 'ok', count: result.models.length, detectedFormat: result.detectedFormat })
    } catch (error: unknown) {
      if (isCurrent()) {
        setStatus({
          kind: 'fail',
          message: `${saving ? '检测成功，但保存设置失败：' : ''}${errorMessage(error)}`
        })
      }
    } finally {
      probing.current = false
    }
  }

  const currentSettings = useRef<Partial<AppSettings>>({})
  currentSettings.current = { useCustomModel: enabled, apiFormat, apiBase: apiBase.trim(), apiKey: apiKey.trim(), model: model.trim(), modelVision: modelVision.trim(), modelChat: modelChat.trim() }

  useExitParticipant({
    id: 'custom-model-settings',
    label: '自定义模型设置',
    isDirty: () => false,
    alwaysPrepare: true,
    prepare: async () => {
      if (loading) return
      await saveQueue.current
      const next = currentSettings.current
      if (Object.entries(next).some(([key, value]) => savedSettings.current[key as keyof AppSettings] !== value)) {
        await savePatch(next)
      }
    }
  })

  const tiers = [
    {
      key: 'model' as const,
      label: '文本抽取',
      hint: '剪贴板、屏幕感知、文本解析。检测使用此模型',
      value: model,
      set: setModel,
      placeholder: '填写服务支持的模型 ID'
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
  const locked = loading || status.kind === 'probing'
  const detectedLabel = status.kind === 'ok'
    ? API_FORMATS.find((format) => format.value === status.detectedFormat)?.label ?? '未知协议'
    : ''

  return (
    <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-slate-500">API 地址</span>
        <input
          className={input}
          placeholder="https://api.openai.com/v1"
          value={apiBase}
          onChange={(e) => {
            changed()
            setApiBase(e.target.value)
            setModels([])
          }}
          onBlur={() => save({ apiBase: apiBase.trim() })}
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
            onChange={(e) => {
              changed()
              setApiKey(e.target.value)
              setModels([])
            }}
            onBlur={() => save({ apiKey: apiKey.trim() })}
          />
          <button
            className="shrink-0 rounded-lg border border-slate-300 px-3 text-xs text-slate-500 hover:bg-slate-50"
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </label>

      <div className="flex flex-col gap-3 border-t border-slate-200 pt-3">
        <div className="text-xs text-slate-400">
          只填「文本抽取」就能使用，读图和对话可按需指定。
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
                onChange={(e) => {
                  changed()
                  tier.set(e.target.value)
                  save({ [tier.key]: e.target.value })
                }}
              >
                <option value="">{tier.key === 'model' ? '请选择模型' : '（跟随文本抽取）'}</option>
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
                onChange={(e) => {
                  changed()
                  tier.set(e.target.value)
                }}
                onBlur={() => save({ [tier.key]: tier.value.trim() })}
              />
            )}
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
          onClick={() => void probe('auto')}
        >
          {status.kind === 'probing' ? '检测并保存中…' : '自动检测并保存'}
        </button>
        {status.kind === 'ok' && (
          <span className="text-xs text-emerald-600">
            连接正常，已保存 · {detectedLabel}
            {status.count ? `，发现 ${status.count} 个模型` : '；服务未提供模型列表，可手动填写'}
          </span>
        )}
        {status.kind === 'fail' && <span className="text-xs text-amber-600">{status.message}</span>}
      </div>

      <details className="rounded-lg border border-slate-200 px-3 py-2">
        <summary className="cursor-pointer text-xs text-slate-500">
          高级：接口格式（当前：{API_FORMATS.find((format) => format.value === apiFormat)?.label}）
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <select
            className={input}
            aria-label="接口格式"
            value={apiFormat}
            onChange={(e) => {
              const next = normalizeApiFormat(e.target.value)
              changed()
              setApiFormat(next)
              save({ apiFormat: next })
            }}
          >
            {API_FORMATS.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-slate-400">
            {API_FORMATS.find((format) => format.value === apiFormat)?.hint}
          </span>
          {apiFormat !== 'auto' && (
            <button
              className="self-start rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
              onClick={() => void probe(apiFormat)}
            >
              验证手动格式
            </button>
          )}
        </div>
      </details>

      {saveError && <p className="text-xs text-amber-600">{saveError}</p>}

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
            changed()
            setEnabled(next)
            save({ useCustomModel: next })
          }}
        />
      </label>

      <p className="text-xs text-slate-400">
        支持 OpenAI Responses、OpenAI Chat 和 Anthropic 协议，默认自动识别。
        检测会向文本抽取模型发送简短测试请求，消耗少量 API 额度；不提供模型列表的服务也可使用。
      </p>
    </fieldset>
  )
}
