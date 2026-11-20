// 设置页「集成」里的谷子云端 MCP：登录谷子账号后，AI 客户端用固定地址 + token 访问这台电脑上的谷子助手。
import { useEffect, useState } from 'react'
import type { CloudConnection, CloudState, CloudToken, CreatedCloudToken } from '@shared/cloud'
import { api } from '../../api'
import { Section, Toggle } from '../ui'

const STATUS: Record<CloudConnection, { label: string; tone: string }> = {
  signed_out: { label: '未登录', tone: 'text-slate-400' },
  disabled: { label: '已关闭', tone: 'text-slate-400' },
  idle: { label: '未连接', tone: 'text-slate-400' },
  connecting: { label: '连接中…', tone: 'text-amber-600' },
  online: { label: '在线', tone: 'text-emerald-600' },
  reconnecting: { label: '重新连接中…', tone: 'text-amber-600' },
  error: { label: '出错', tone: 'text-red-500' }
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'
const ghost = 'shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50'
const primary = 'rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-50'

/** IPC 错误会带上 "Error invoking remote method …: Error: " 前缀，只保留服务端给出的提示。 */
export function cloudErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/,
    ''
  )
}

type Mode = 'login' | 'code' | 'register'

export default function CloudMcpSection({ flash }: { flash: (msg: string) => void }): React.JSX.Element {
  const [state, setState] = useState<CloudState | null>(null)
  const [mode, setMode] = useState<Mode>('login')
  const [form, setForm] = useState({ identifier: '', password: '', email: '', code: '', username: '' })
  const [cooldown, setCooldown] = useState(0)
  const [tokens, setTokens] = useState<CloudToken[]>([])
  const [tokenName, setTokenName] = useState('')
  const [bindDevice, setBindDevice] = useState(false)
  const [created, setCreated] = useState<CreatedCloudToken | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true
    const off = window.guziAssistant.on('guzi-assistant:cloud-state', (next) => setState(next as CloudState))
    api.cloudState().then(
      (next) => mounted && setState(next),
      (cause) => mounted && setError(cloudErrorMessage(cause))
    )
    return () => {
      mounted = false
      off()
    }
  }, [])

  const signedIn = !!state?.signedIn
  useEffect(() => {
    if (!signedIn) {
      setTokens([])
      return
    }
    api.cloudTokens().then(setTokens, () => setTokens([]))
  }, [signedIn])

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await operation()
    } catch (cause) {
      setError(cloudErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }
  const field = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: event.target.value })
  const copy = (text: string, message = '已复制'): void => {
    void navigator.clipboard.writeText(text)
    flash(message)
  }
  const refreshTokens = async (): Promise<void> => setTokens(await api.cloudTokens())

  const status = STATUS[state?.connection ?? 'signed_out']

  return (
    <Section title="谷子云端 MCP">
      <p className="mb-3 text-xs leading-5 text-slate-400">
        {'登录谷子账号后，AI 客户端用固定地址和你的 token 就能使用谷子助手的工具，不需要开放本机端口。工具仍在这台电脑上执行，任务数据不会存到云端；使用时请保持谷子助手运行。'}
      </p>
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className={`text-xs ${status.tone}`} role="status">
            {status.label}
          </span>
          {signedIn && (
            <label className="flex items-center gap-2">
              <span>启用云端 MCP</span>
              <Toggle
                checked={!!state?.enabled}
                ariaLabel="启用云端 MCP"
                disabled={pending}
                onChange={(on) => run(() => api.cloudSetEnabled(on))}
              />
            </label>
          )}
        </div>
        {state?.error && <p className="text-xs text-red-500">{state.error}</p>}

        {!signedIn && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                if (mode === 'login') await api.cloudLogin(form.identifier.trim(), form.password)
                else if (mode === 'code') await api.cloudLoginWithCode(form.email.trim(), form.code.trim())
                else
                  await api.cloudRegister({
                    username: form.username.trim(),
                    password: form.password,
                    email: form.email.trim(),
                    code: form.code.trim()
                  })
                setForm({ identifier: '', password: '', email: '', code: '', username: '' })
                flash('已登录谷子账号')
              })
            }}
          >
            <div className="inline-flex w-fit gap-1 rounded-lg bg-slate-100 p-1 text-xs" role="tablist">
              {(
                [
                  ['login', '账号密码登录'],
                  ['code', '邮箱验证码登录'],
                  ['register', '注册']
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mode === id}
                  className={`rounded-md px-3 py-1 ${mode === id ? 'bg-white font-medium text-slate-800 shadow-sm' : 'text-slate-500'}`}
                  onClick={() => {
                    setMode(id)
                    setError('')
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'login' ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500">账号 / 邮箱</span>
                  <input className={input} autoComplete="username" value={form.identifier} onChange={field('identifier')} required />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500">密码</span>
                  <input className={input} type="password" autoComplete="current-password" value={form.password} onChange={field('password')} required />
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500">邮箱</span>
                  <input className={input} type="email" autoComplete="email" value={form.email} onChange={field('email')} required />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500">验证码</span>
                  <span className="flex gap-2">
                    <input className={input} inputMode="numeric" maxLength={6} value={form.code} onChange={field('code')} required />
                    <button
                      type="button"
                      className={ghost}
                      disabled={pending || cooldown > 0 || !form.email.trim()}
                      onClick={() =>
                        void run(async () => {
                          const result = await api.cloudRequestCode(mode === 'register' ? 'register' : 'login', form.email.trim())
                          setCooldown(result.cooldownSeconds || 60)
                          flash('验证码已发送，请查收邮件')
                        })
                      }
                    >
                      {cooldown > 0 ? `${cooldown} 秒` : '发送验证码'}
                    </button>
                  </span>
                </label>
                {mode === 'register' && (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-500">账号名</span>
                      <input className={input} autoComplete="username" value={form.username} onChange={field('username')} required />
                      <span className="text-xs text-slate-400">3–32 位，以字母开头，可用字母、数字、_ 和 -</span>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-slate-500">密码</span>
                      <input className={input} type="password" autoComplete="new-password" value={form.password} onChange={field('password')} required />
                      <span className="text-xs text-slate-400">至少 8 位，需同时包含字母和数字</span>
                    </label>
                  </>
                )}
              </div>
            )}
            <div className="flex items-center gap-3">
              <button type="submit" className={primary} disabled={pending}>
                {mode === 'register' ? '注册并登录' : '登录'}
              </button>
              <button type="button" className="text-xs text-slate-500 hover:text-slate-700" onClick={() => void api.cloudOpenAccount()}>
                在网页上管理账号 / 找回密码
              </button>
            </div>
          </form>
        )}

        {signedIn && state && (
          <>
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-slate-500">账号</span>
              <span className="min-w-0 flex-1 truncate">
                {state.user?.username}
                {state.user?.email ? <span className="text-slate-400">（{state.user.email}）</span> : null}
              </span>
              <button type="button" className={ghost} onClick={() => void api.cloudOpenAccount()}>
                管理账号
              </button>
              <button type="button" className={ghost} disabled={pending} onClick={() => void run(() => api.cloudLogout())}>
                退出登录
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-slate-500">地址</span>
              <code className="select-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">{state.endpoint}</code>
              <button type="button" className={ghost} onClick={() => copy(state.endpoint, '地址已复制')}>
                复制
              </button>
            </div>

            <div>
              <div className="mb-1 text-slate-500">访问 token</div>
              <p className="mb-2 text-xs leading-5 text-slate-400">每个 token 只能访问谷子助手；删除后立即失效。</p>
              {tokens.length === 0 && <p className="text-xs text-slate-400">还没有 token。</p>}
              <ul className="divide-y divide-slate-100">
                {tokens.map((token) => (
                  <li key={token.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate">
                        {token.name}
                        {token.deviceId === state.deviceId && <span className="ml-2 text-xs text-slate-400">仅这台电脑</span>}
                      </div>
                      <div className="text-xs text-slate-400">
                        <code>{token.hint}</code> · 最近使用 {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : '从未'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={ghost}
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          await api.cloudRevokeToken(token.id)
                          await refreshTokens()
                          flash('token 已删除')
                        })
                      }
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {created ? (
              <div className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3">
                <div className="text-xs text-amber-700">这是唯一一次显示完整 token，请现在复制保存。之后只能删除重建。</div>
                <code className="select-all break-all rounded bg-white px-2 py-1 font-mono text-xs">{created.token}</code>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={ghost} onClick={() => copy(created.token, 'token 已复制')}>
                    复制 token
                  </button>
                  <button type="button" className={ghost} onClick={() => copy(created.configs.claudeCode, '已复制 Claude Code 命令')}>
                    复制 Claude Code 命令
                  </button>
                  <button type="button" className={ghost} onClick={() => copy(created.configs.json, '已复制 JSON 配置')}>
                    复制 JSON 配置
                  </button>
                  <button type="button" className={ghost} onClick={() => copy(created.configs.codex, '已复制 Codex 配置')}>
                    复制 Codex 配置
                  </button>
                  <button type="button" className={ghost} onClick={() => setCreated(null)}>
                    完成
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="flex flex-wrap items-center gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(async () => {
                    setCreated(await api.cloudCreateToken(tokenName.trim(), bindDevice))
                    setTokenName('')
                    await refreshTokens()
                  })
                }}
              >
                <input
                  className={`${input} max-w-xs`}
                  aria-label="token 名称"
                  placeholder="例如：工作电脑上的 Claude Code"
                  maxLength={48}
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                  required
                />
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  <Toggle checked={bindDevice} ariaLabel="只转发到这台电脑" onChange={setBindDevice} />
                  只转发到这台电脑
                </span>
                <button type="submit" className={primary} disabled={pending || !tokenName.trim()}>
                  新建 token
                </button>
              </form>
            )}
          </>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    </Section>
  )
}
