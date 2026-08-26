// 设置页「集成」分区。状态仍由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings, FeishuStatus } from '@shared/types'
import { api } from '../../api'
import { Section, Toggle } from '../ui'

/** 生成 MCP Bearer token：48 位十六进制随机串（浏览器安全随机源） */
function genMcpToken(): string {
  const buf = new Uint8Array(24)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 本分区两处文本输入框的统一样式。 */
const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

interface Props {
  settings: AppSettings
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  qaInstalled: boolean
  setQaInstalled: Dispatch<SetStateAction<boolean>>
  feishu: FeishuStatus | null
  setFeishu: Dispatch<SetStateAction<FeishuStatus | null>>
  flash: (msg: string) => void
}

export default function IntegrationSection({
  settings, setSettings, qaInstalled, setQaInstalled, feishu, setFeishu, flash
}: Props): React.JSX.Element {
  return (
    <>
            <Section title="系统集成">
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div>访达右键快速操作</div>
                    <div className="mt-0.5 text-xs leading-5 text-slate-400">
                      安装后在访达中选中文件 → 右键 → 快速操作 → 「发送到 谷子助手」，文件会直接进入解析流程（应用未运行时会在下次启动时补处理）。
                    </div>
                  </div>
                  <button
                    className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs ${
                      qaInstalled
                        ? 'border-slate-200 text-slate-500 hover:bg-slate-50'
                        : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                    onClick={async () => {
                      const ok = await api.installQuickAction()
                      setQaInstalled(ok)
                      flash(ok ? '已安装到 访达 右键菜单' : '安装失败，请重试')
                    }}
                  >
                    {qaInstalled ? '已安装（点击重装）' : '安装'}
                  </button>
                </div>
                <div>
                  <div>托盘拖拽</div>
                  <div className="mt-0.5 text-xs leading-5 text-slate-400">
                    把文件直接拖到菜单栏的 谷子助手 图标上即可提交解析，无需安装。
                  </div>
                </div>
              </div>
            </Section>

            <Section title="MCP 接口">
              <p className="mb-3 text-xs leading-5 text-slate-400">
                把谷子的任务、工作记录、日报能力以 MCP 工具暴露给你自己的 AI 客户端（Claude Desktop / Cursor / Claude
                Code 等），让它们替你查日程、加任务、标完成。服务只监听本机（127.0.0.1），凭下方 token
                访问——token 即访问凭证，请勿泄露给他人。
              </p>
              <div className="flex flex-col gap-3 text-sm">
                <label className="flex items-center justify-between gap-4">
                  <span>启用 MCP 服务</span>
                  <Toggle
                    checked={settings.mcpEnabled}
                    ariaLabel="启用 MCP 服务"
                    onChange={async (on) => {
                      const patch: Partial<AppSettings> = { mcpEnabled: on }
                      if (on && !settings.mcpToken) patch.mcpToken = genMcpToken()
                      await api.saveSettings(patch)
                      setSettings((s) => (s ? { ...s, ...patch } : s))
                      flash(on ? 'MCP 服务已启动' : 'MCP 服务已停止')
                    }}
                  />
                </label>
                {settings.mcpEnabled && (
                  <>
                    <div className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-slate-500">端口</span>
                      <input
                        type="number"
                        min={1024}
                        max={65535}
                        className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                        value={settings.mcpPort}
                        onChange={(e) => setSettings({ ...settings, mcpPort: Number(e.target.value) })}
                        onBlur={async (e) => {
                          const v = Math.min(65535, Math.max(1024, Number(e.target.value) || 38999))
                          setSettings({ ...settings, mcpPort: v })
                          await api.saveSettings({ mcpPort: v })
                          flash(`MCP 服务已在端口 ${v} 重启`)
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-slate-500">地址</span>
                      <code className="select-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">
                        http://127.0.0.1:{settings.mcpPort}/mcp
                      </code>
                      <button
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        onClick={() => {
                          void navigator.clipboard.writeText(`http://127.0.0.1:${settings.mcpPort}/mcp`)
                          flash('地址已复制')
                        }}
                      >
                        复制
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-slate-500">Token</span>
                      <code className="select-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">
                        {settings.mcpToken ? `${settings.mcpToken.slice(0, 8)}…` : '（未生成）'}
                      </code>
                      <button
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        onClick={() => {
                          void navigator.clipboard.writeText(settings.mcpToken)
                          flash('Token 已复制')
                        }}
                      >
                        复制
                      </button>
                      <button
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                        onClick={async () => {
                          const t = genMcpToken()
                          await api.saveSettings({ mcpToken: t })
                          setSettings((s) => (s ? { ...s, mcpToken: t } : s))
                          flash('已重新生成，旧 token 立即失效，请更新客户端配置')
                        }}
                      >
                        重新生成
                      </button>
                    </div>
                    <div>
                      <div className="mb-1 text-xs text-slate-500">客户端配置示例（Claude Desktop / Cursor 的 mcpServers）：</div>
                      <pre className="select-text overflow-x-auto rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] leading-5 text-slate-600">
                        {`{
        "mcpServers": {
          "guzi-assistant": {
            "url": "http://127.0.0.1:${settings.mcpPort}/mcp",
            "headers": { "Authorization": "Bearer ${settings.mcpToken || '<token>'}" }
          }
        }
      }`}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            </Section>

            <Section title="飞书机器人">
              <p className="mb-3 text-xs leading-5 text-slate-400">
                在飞书里把通知/截图直接转发给机器人，自动进入待确认列表。配置步骤：飞书开放平台（open.feishu.cn）创建企业自建应用
                → 添加「机器人」能力 → 权限开通 im:message（接收与发送单聊消息）→ 事件订阅选择「使用长连接接收事件」并添加
                im.message.receive_v1 → 创建版本发布。无需公网服务器。
              </p>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500">App ID</span>
                  <input
                    className={input}
                    value={settings.feishuAppId}
                    onChange={(e) => setSettings({ ...settings, feishuAppId: e.target.value })}
                    placeholder="cli_xxx"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-500">App Secret</span>
                  <input
                    type="password"
                    className={input}
                    value={settings.feishuAppSecret}
                    onChange={(e) => setSettings({ ...settings, feishuAppSecret: e.target.value })}
                  />
                </label>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark"
                  onClick={async () => {
                    await api.saveSettings({
                      feishuAppId: settings.feishuAppId.trim(),
                      feishuAppSecret: settings.feishuAppSecret.trim()
                    })
                    flash('已保存，正在连接…')
                    window.setTimeout(() => void api.feishuStatus().then(setFeishu), 2000)
                  }}
                >
                  保存并连接
                </button>
                <button
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
                  onClick={() => void api.feishuStatus().then(setFeishu)}
                >
                  刷新状态
                </button>
                {feishu && (
                  <span
                    className={`text-xs ${
                      feishu.status === 'connected'
                        ? 'text-emerald-600'
                        : feishu.status === 'error'
                          ? 'text-red-500'
                          : feishu.status === 'disabled'
                            ? 'text-slate-400'
                            : 'text-amber-600'
                    }`}
                  >
                    {feishu.status === 'connected' && '已连接'}
                    {feishu.status === 'connecting' && '连接中…'}
                    {feishu.status === 'disabled' && '未配置'}
                    {feishu.status === 'error' && `连接失败：${feishu.detail}`}
                    {feishu.status === 'restart_required' && feishu.detail}
                  </span>
                )}
              </div>
            </Section>
    </>
  )
}
