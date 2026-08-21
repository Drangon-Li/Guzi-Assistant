import { useEffect, useState } from 'react'
import type {
  AppSettings,
  FeishuStatus,
  PermissionStatus,
  Profile,
  ScreenActivityStatus
} from '@shared/types'
import { api } from '../api'
import { CONFIRM_MODES, formatHotkey } from '../labels'
import PetSettings from '../components/PetSettings'
import FeedbackSection from '../components/FeedbackSection'
import { Section } from '../components/ui'

interface Props {
  onProfileChange: (p: Profile) => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

const CATS = ['通用', '快捷键', '助手', '集成', '屏幕感知', '数据', '关于'] as const

type HotkeyField =
  | 'hotkey'
  | 'screenshotHotkey'
  | 'screenSenseHotkey'
  | 'mainWindowHotkey'
  | 'petVoiceHotkey'
  | 'quickAskHotkey'

// 快捷键设置行：新增全局快捷键时在这里登记一行即可（录制/保存/展示逻辑通用）
const HOTKEY_ROWS: { key: HotkeyField; label: string }[] = [
  { key: 'hotkey', label: '提交剪切板' },
  { key: 'screenshotHotkey', label: '提交屏幕截图' },
  { key: 'screenSenseHotkey', label: '整屏感知扫描' },
  { key: 'mainWindowHotkey', label: '打开主界面' },
  { key: 'petVoiceHotkey', label: '桌宠说话模式' },
  { key: 'quickAskHotkey', label: '快捷提问框' }
]

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Enter: 'Enter',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

/** 生成 MCP Bearer token：48 位十六进制随机串（浏览器安全随机源） */
function genMcpToken(): string {
  const buf = new Uint8Array(24)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** KeyboardEvent → Electron accelerator；组合不完整时返回 null（继续等待按键） */
function eventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.metaKey) mods.push('Command')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let key: string | null = null
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3)
  else if (/^Digit\d$/.test(c)) key = c.slice(5)
  else if (/^F\d{1,2}$/.test(c)) key = c
  else if (c in CODE_KEYS) key = CODE_KEYS[c]
  if (!key) return null
  // 普通键必须带修饰键，否则会全局吞掉日常输入；F1-F12 例外
  if (!mods.length && !/^F\d/.test(key)) return null
  return [...mods, key].join('+')
}

function splitList(s: string): string[] {
  return s
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}


export default function Settings({ onProfileChange }: Props): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [perms, setPerms] = useState<PermissionStatus | null>(null)
  const [note, setNote] = useState('')
  const [recordingKey, setRecordingKey] = useState<HotkeyField | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [cat, setCat] = useState<(typeof CATS)[number]>('通用')
  const [qaInstalled, setQaInstalled] = useState(false)
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null)
  const [activityStatus, setActivityStatus] = useState<ScreenActivityStatus | null>(null)
  const todayStr = new Date().toISOString().slice(0, 10)
  const weekAgoStr = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)
  const [exportFrom, setExportFrom] = useState(weekAgoStr)
  const [exportTo, setExportTo] = useState(todayStr)

  const loadPerms = (): void => {
    void api.permissions().then(setPerms)
  }

  const loadActivityStatus = (): void => {
    void api.screenActivityStatus().then(setActivityStatus)
  }

  useEffect(() => {
    void api.getProfile().then(setProfile)
    void api.appVersion().then(setAppVersion)
    void api.getSettings().then(setSettings)
    void api.quickActionStatus().then(setQaInstalled)
    void api.feishuStatus().then(setFeishu)
    loadPerms()
    loadActivityStatus()
    const timer = window.setInterval(loadActivityStatus, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2500)
  }

  // 统一的快捷键录制：进入录制态后按下的组合直接保存到对应设置字段
  useEffect(() => {
    if (!recordingKey) return
    const key = recordingKey
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecordingKey(null)
        return
      }
      const acc = eventToAccelerator(e)
      if (!acc) return
      setRecordingKey(null)
      void (async () => {
        const ok = await api.saveSettings({ [key]: acc })
        if (ok) {
          setSettings((s) => (s ? { ...s, [key]: acc } : s))
          flash(`快捷键已设为 ${formatHotkey(acc)}`)
        } else {
          flash('注册失败：该组合可能被系统或其他应用占用')
        }
      })()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recordingKey])

  if (!profile || !settings) return <div className="p-8 text-sm text-slate-400">加载中…</div>

  const saveProfile = async (next: Profile): Promise<void> => {
    setProfile(next)
    await api.saveProfile(next)
    onProfileChange(next)
  }

  const wipe = async (): Promise<void> => {
    if (!window.confirm('将删除所有任务、来源和用户档案，无法恢复。确定清除？')) return
    await api.wipeData()
    window.location.reload()
  }

  // 原记忆页的「清空所有记忆」，随记忆页拆解移入数据管理
  const wipeMemory = async (): Promise<void> => {
    if (
      !window.confirm(
        '将清空活动记录、个人记忆、来源历史与屏幕识别历史，无法恢复。任务、日报与个人档案不受影响。确定清空？'
      )
    )
      return
    await api.wipeMemory()
    window.location.reload()
  }

  return (
    <div className="mx-auto flex max-w-4xl gap-6 px-8 py-8">
      {/* sticky：右侧内容长页滚动时分类栏钉在视口，不跟着滚走 */}
      <nav className="sticky top-8 flex w-28 shrink-0 flex-col gap-1 self-start pt-0.5">
        <h1 className="mb-2 px-3 text-lg font-semibold">设置</h1>
        {CATS.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
              cat === c ? 'bg-elevated font-medium text-slate-700' : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            {c}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-5 pb-12">
        {cat === '通用' && (
          <>
      <Section title="外观">
        <div className="flex gap-2">
          {(
            [
              { v: 'system', label: '跟随系统' },
              { v: 'light', label: '浅色' },
              { v: 'dark', label: '深色' }
            ] as const
          ).map((t) => (
            <button
              key={t.v}
              onClick={() => {
                void api.saveSettings({ theme: t.v })
                setSettings((s) => (s ? { ...s, theme: t.v } : s))
                flash('外观已更新')
              }}
              className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                (settings?.theme ?? 'system') === t.v
                  ? 'border-slate-400 bg-elevated'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="确认模式">
        <div className="flex flex-col gap-2">
          {CONFIRM_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => {
                void saveProfile({ ...profile, confirmMode: m.value })
                flash('确认模式已更新')
              }}
              className={`rounded-xl border px-4 py-2.5 text-left ${
                profile.confirmMode === m.value
                  ? 'border-slate-400 bg-elevated'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <div className="text-xs text-slate-400">{m.desc}</div>
            </button>
          ))}
        </div>
      </Section>
          </>
        )}
        {cat === '快捷键' && (
          <>
      <Section title="快捷键">
        <div className="flex flex-col gap-3 text-sm">
          {HOTKEY_ROWS.map((row) => (
            <div key={row.key} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-slate-500">{row.label}</span>
              <button
                onClick={() => setRecordingKey(recordingKey === row.key ? null : row.key)}
                className={`min-w-44 rounded-lg border px-4 py-2 font-medium ${
                  recordingKey === row.key
                    ? 'animate-pulse border-slate-400 bg-elevated text-slate-700'
                    : 'border-slate-300 hover:border-slate-400'
                }`}
              >
                {recordingKey === row.key ? '按下新组合键…' : formatHotkey(settings[row.key])}
              </button>
              {recordingKey === row.key && <span className="text-xs text-slate-400">Esc 取消</span>}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-400">
          点击按键框后直接按下想要的组合：需包含至少一个修饰键（⌘ ⌥ ⌃ ⇧），F1–F12
          可单独使用。注册失败说明该组合被系统或其他应用占用。「整屏感知扫描」需先在「屏幕感知」里开启本地智能检测才会生效。「快捷提问框」在任意应用里唤起：回车问助手，⌘回车直接记日程。
        </p>
      </Section>
          </>
        )}
        {cat === '助手' && (
          <>
      <Section title="悬浮助手">
        <label className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">闲置自动收起</span>
          <input
            type="number"
            min={0}
            max={600}
            className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            value={settings.assistantAutoCloseSec}
            onChange={(e) =>
              setSettings({ ...settings, assistantAutoCloseSec: Number(e.target.value) })
            }
            onBlur={async (e) => {
              const v = Math.min(600, Math.max(0, Number(e.target.value) || 0))
              setSettings({ ...settings, assistantAutoCloseSec: v })
              await api.saveSettings({ assistantAutoCloseSec: v })
              flash(v ? `闲置 ${v} 秒自动收起助手` : '已关闭自动收起')
            }}
          />
          <span className="text-xs text-slate-400">秒，0 = 不自动收起</span>
        </label>
      </Section>

      <Section title="桌宠">
        <PetSettings />
      </Section>
          </>
        )}
        {cat === '集成' && (
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
            <input
              type="checkbox"
              checked={settings.mcpEnabled}
              onChange={async (e) => {
                const on = e.target.checked
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
        )}
        {cat === '屏幕感知' && (
          <>
      <Section title="屏幕感知（持续被动采集）">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          屏幕感知默认关闭。开启后，谷子助手先在本机观察前台 App 与窗口变化，不记录键盘正文；Hybrid v2 会先评估语义完整度，只有语义不足时才截图并在本地 OCR。
          默认只把脱敏后的 OCR 文字送解析，截图仅在你开启「日程深度确认」时上传。私密浏览始终跳过；原图用完即弃，证据缩略图也默认不保存。
        </p>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>屏幕感知</span>
          <input
            type="checkbox"
            checked={settings.screenSenseEnabled}
            onChange={async (e) => {
              const next = e.target.checked
              setSettings({ ...settings, screenSenseEnabled: next })
              await api.saveSettings({ screenSenseEnabled: next })
              flash(next ? '已开启屏幕感知' : '已关闭屏幕感知')
            }}
          />
        </label>

        {settings.screenSenseEnabled && (
          <div className="mt-4 flex flex-col gap-4">
            <div className="border-y border-slate-100 py-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  事件驱动模式
                  <span className="ml-2 text-xs text-slate-400">
                    App/窗口变化触发扫描，静止时低频兜底；不可用时自动停止截图
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.screenSenseEventDriven}
                  onChange={async (e) => {
                    const next = e.target.checked
                    const interval = next
                      ? Math.max(5, settings.screenSenseIntervalSec)
                      : settings.screenSenseIntervalSec
                    setSettings({
                      ...settings,
                      screenSenseEventDriven: next,
                      screenSenseIntervalSec: interval
                    })
                    await api.saveSettings({
                      screenSenseEventDriven: next,
                      screenSenseIntervalSec: interval
                    })
                    loadActivityStatus()
                    flash(next ? '已开启事件驱动模式' : '已恢复固定间隔扫描')
                  }}
                />
              </label>
              {settings.screenSenseEventDriven && (
                <label className="mt-3 flex items-center gap-3 text-sm">
                  <span className="text-slate-500">静止兜底间隔</span>
                  <input
                    type="number"
                    min={30}
                    max={60}
                    className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                    value={settings.screenSenseFallbackIntervalSec}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        screenSenseFallbackIntervalSec: Number(e.target.value)
                      })
                    }
                    onBlur={async (e) => {
                      const v = Math.min(60, Math.max(30, Number(e.target.value) || 45))
                      setSettings({ ...settings, screenSenseFallbackIntervalSec: v })
                      await api.saveSettings({ screenSenseFallbackIntervalSec: v })
                      flash(`静止时最多每 ${v} 秒检查一次`)
                    }}
                  />
                  <span className="text-xs text-slate-400">秒</span>
                </label>
              )}
              <label className="mt-3 flex items-center justify-between gap-4 text-sm">
                <span>
                  Hybrid History v2
                  <span className="ml-2 text-xs text-slate-400">
                    语义充分直接进入片段；语义不足才按需 OCR。关闭后回到 legacy 事件/兜底扫描
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.screenSenseHybridV2}
                  onChange={async (e) => {
                    const next = e.target.checked
                    setSettings({ ...settings, screenSenseHybridV2: next })
                    await api.saveSettings({ screenSenseHybridV2: next })
                    loadActivityStatus()
                    flash(next ? '已开启 Hybrid History v2' : '已回到 legacy 扫描模式')
                  }}
                />
              </label>
              {activityStatus && (
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span>
                    观察器：
                    {activityStatus.observer === 'healthy'
                      ? '正常'
                      : activityStatus.observer === 'unavailable'
                        ? '已降级停止截图'
                        : '等待前台上下文'}
                  </span>
                  <span>内存事件：{activityStatus.rawEventCount}</span>
                  <span>
                    最后事件：
                    {activityStatus.lastEventAt
                      ? new Date(activityStatus.lastEventAt).toLocaleTimeString()
                      : '暂无'}
                  </span>
                  <span>
                    最后扫描：
                    {activityStatus.lastScanAt
                      ? `${new Date(activityStatus.lastScanAt).toLocaleTimeString()} · ${activityStatus.lastScanReason ?? '未知'}`
                      : '暂无'}
                  </span>
                  <span>10 分钟片段：{activityStatus.tenMinuteSegmentCount}</span>
                  <span>6 小时汇总：{activityStatus.sixHourSegmentCount}</span>
                  <span>
                    Collector：{activityStatus.collector === 'healthy' ? '正常' : activityStatus.collector === 'degraded' ? '降级' : activityStatus.collector === 'starting' ? '启动中' : '已停止'}
                  </span>
                  <span>
                    Accessibility：{activityStatus.accessibility === 'available' ? '可用' : activityStatus.accessibility === 'unavailable' ? '未授权（不影响基础事件）' : '未知'}
                  </span>
                  <span>语义覆盖率：{activityStatus.semanticCoverage}%</span>
                  <span>OCR fallback：{activityStatus.ocrFallbackCount} 次</span>
                  <span>
                    工作归类：{activityStatus.workClassificationStatus === 'pending'
                      ? '进行中'
                      : activityStatus.workClassificationStatus === 'ok'
                        ? activityStatus.workClassificationSource === 'accessibility'
                          ? 'Accessibility 语义'
                          : 'OCR 补证'
                        : activityStatus.workClassificationStatus === 'unavailable'
                          ? '服务未就绪'
                          : activityStatus.workClassificationStatus === 'error'
                            ? '失败'
                            : '暂无'}
                  </span>
                  <span>
                    最近归类：{activityStatus.workClassificationAt
                      ? new Date(activityStatus.workClassificationAt).toLocaleTimeString()
                      : '暂无'}
                  </span>
                  <span className="col-span-2">
                    最近 10 分钟构成：事件 {activityStatus.latestEventCount}（有效 {activityStatus.latestMeaningfulEventCount}） · 完整 {activityStatus.latestSemanticCompleteCount} · 部分 {activityStatus.latestSemanticPartialCount} · 空 {activityStatus.latestSemanticEmptyCount} · OCR {activityStatus.latestOcrEvidenceCount}
                  </span>
                  <span className="col-span-2">
                    触发原因：{activityStatus.recentTriggerReasons.length ? activityStatus.recentTriggerReasons.join('、') : '暂无'}
                  </span>
                  <span className="col-span-2">最近摘要：{activityStatus.recentSummary ?? '暂无'}</span>
                  {activityStatus.workClassificationDetail && (
                    <span className="col-span-2">归类详情：{activityStatus.workClassificationDetail}</span>
                  )}
                  {activityStatus.observerDetail && (
                    <span className="col-span-2 text-amber-600">{activityStatus.observerDetail}</span>
                  )}
                  {activityStatus.collectorDetail && (
                    <span className="col-span-2 text-amber-600">Collector：{activityStatus.collectorDetail}</span>
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  检测到日程时弹窗提醒
                  <span className="ml-2 text-xs text-slate-400">
                    关闭则完全被动，只在「记忆」里留存供回看
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.screenSensePopup}
                  onChange={async (e) => {
                    const next = e.target.checked
                    setSettings({ ...settings, screenSensePopup: next })
                    await api.saveSettings({ screenSensePopup: next })
                    flash(next ? '检测到日程会弹窗提醒' : '已转为完全被动（只进记忆）')
                  }}
                />
              </label>
            </div>

            {settings.screenSensePopup && (
              <label className="flex items-center gap-3 pl-1 text-sm">
                <span className="text-slate-500">弹窗无操作自动忽略</span>
                <input
                  type="number"
                  min={0}
                  max={600}
                  className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                  value={settings.screenSenseCardHideSec}
                  onChange={(e) =>
                    setSettings({ ...settings, screenSenseCardHideSec: Number(e.target.value) })
                  }
                  onBlur={async (e) => {
                    const v = Math.min(600, Math.max(0, Number(e.target.value) || 0))
                    setSettings({ ...settings, screenSenseCardHideSec: v })
                    await api.saveSettings({ screenSenseCardHideSec: v })
                    flash(v ? `弹窗 ${v} 秒无操作自动忽略` : '弹窗将一直显示，需手动处理')
                  }}
                />
                <span className="text-xs text-slate-400">秒（进度条走满自动忽略），0 = 一直显示</span>
              </label>
            )}

            <div className="border-t border-slate-100 pt-4">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  工作记录
                  <span className="ml-2 text-xs text-slate-400">
                    识别时顺带记下「在做什么」，供「日报」页生成工作日报（不额外耗积分）
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.screenSenseWorkLog}
                  onChange={async (e) => {
                    const next = e.target.checked
                    setSettings({ ...settings, screenSenseWorkLog: next })
                    await api.saveSettings({ screenSenseWorkLog: next })
                    flash(next ? '已开启工作记录' : '已关闭工作记录')
                  }}
                />
              </label>
              {settings.screenSenseWorkLog && (
                <label className="mt-2 flex items-center gap-3 text-sm">
                  <span className="text-slate-500">每日自动生成日报</span>
                  <input
                    type="time"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                    value={settings.dailyReportTime}
                    onChange={async (e) => {
                      const v = e.target.value
                      setSettings({ ...settings, dailyReportTime: v })
                      await api.saveSettings({ dailyReportTime: v })
                      flash(v ? `每天 ${v} 自动生成日报` : '已关闭定时日报')
                    }}
                  />
                  <span className="text-xs text-slate-400">清空 = 不自动生成</span>
                </label>
              )}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  日程深度确认
                  <span className="ml-2 text-xs text-slate-400">
                    检出日程候选后把截图发视觉模型二次确认，更准；注意此时<b>截图会上传云端</b>、额外耗积分
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.screenSenseVlmConfirm}
                  onChange={async (e) => {
                    const next = e.target.checked
                    setSettings({ ...settings, screenSenseVlmConfirm: next })
                    await api.saveSettings({ screenSenseVlmConfirm: next })
                    flash(next ? '已开启日程深度确认（截图上云）' : '已关闭深度确认（仅文字上云）')
                  }}
                />
              </label>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  持续监控（自动）
                  <span className="ml-2 text-xs text-slate-400">屏幕变化时自动识别，无需手动扫描</span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.screenSenseContinuous}
                  onChange={async (e) => {
                    const next = e.target.checked
                    setSettings({ ...settings, screenSenseContinuous: next })
                    await api.saveSettings({ screenSenseContinuous: next })
                    flash(next ? '已开启持续监控' : '已关闭持续监控')
                  }}
                />
              </label>
              {settings.screenSenseContinuous && (
                <div className="mt-3 flex flex-col gap-2">
                  <label className="flex items-center gap-3 text-sm">
                    <span className="text-slate-500">门控检查间隔</span>
                    <input
                      type="number"
                      min={settings.screenSenseEventDriven ? 5 : 1}
                      max={60}
                      className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                      value={settings.screenSenseIntervalSec}
                      onChange={(e) =>
                        setSettings({ ...settings, screenSenseIntervalSec: Number(e.target.value) })
                      }
                      onBlur={async (e) => {
                        const min = settings.screenSenseEventDriven ? 5 : 1
                        const v = Math.min(60, Math.max(min, Number(e.target.value) || 5))
                        setSettings({ ...settings, screenSenseIntervalSec: v })
                        await api.saveSettings({ screenSenseIntervalSec: v })
                        flash('已保存监控间隔')
                      }}
                    />
                    <span className="text-xs text-slate-400">秒</span>
                  </label>
                  <p className="text-xs leading-5 text-slate-400">
                    事件驱动开启时，此间隔只检查是否需要扫描，不会每轮都截图。连续 60 秒无键鼠输入、锁屏或睡眠时不计应用时长。可在菜单栏随时暂停，暂停会取消尚未完成的云端解析。
                  </p>
                  <label className="mt-1 flex flex-col gap-1 text-sm">
                    <span className="text-slate-500">不监控的应用（逗号或顿号分隔）</span>
                    <input
                      className={input}
                      placeholder="如：1Password、微信、网银"
                      defaultValue={settings.screenSenseExcludedApps.join('、')}
                      onBlur={async (e) => {
                        const list = splitList(e.target.value)
                        setSettings({ ...settings, screenSenseExcludedApps: list })
                        await api.saveSettings({ screenSenseExcludedApps: list })
                        flash('已保存应用排除名单')
                      }}
                    />
                    <span className="text-xs text-slate-400">
                      这些应用在前台时不截图、不保存窗口标题；应用使用时长仍按名称统计。中英文名称可都填（如 微信 / WeChat）。
                    </span>
                  </label>

                  <div className="mt-2 border-t border-slate-100 pt-3">
                    <label className="flex items-center justify-between gap-4 text-sm">
                      <span>
                        保存截图到可搜索记忆
                        <span className="ml-2 text-xs text-slate-400">本地加密保存，可在「记忆」里回看</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={settings.screenSenseKeepShots}
                        onChange={async (e) => {
                          const next = e.target.checked
                          setSettings({ ...settings, screenSenseKeepShots: next })
                          await api.saveSettings({ screenSenseKeepShots: next })
                          flash(next ? '已开启截图保存（加密）' : '已关闭截图保存')
                        }}
                      />
                    </label>
                    {settings.screenSenseKeepShots && (
                      <label className="mt-2 flex items-center gap-3 text-sm">
                        <span className="text-slate-500">保留天数</span>
                        <input
                          type="number"
                          min={0}
                          max={365}
                          className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                          value={settings.screenSenseRetentionDays}
                          onChange={(e) =>
                            setSettings({ ...settings, screenSenseRetentionDays: Number(e.target.value) })
                          }
                          onBlur={async (e) => {
                            const v = Math.min(365, Math.max(0, Number(e.target.value) || 0))
                            setSettings({ ...settings, screenSenseRetentionDays: v })
                            await api.saveSettings({ screenSenseRetentionDays: v })
                            flash('已保存截图保留期')
                          }}
                        />
                        <span className="text-xs text-slate-400">天，到期自动清；0 = 永久</span>
                      </label>
                    )}
                    <p className="mt-1.5 text-xs leading-5 text-slate-400">
                      默认关闭，保持「截图用完即弃」。开启后仅保存缩略图、用系统钥匙串加密；原图始终不留。
                    </p>
                  </div>
                </div>
              )}
            </div>

            {perms && perms.screen !== 'granted' && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                屏幕录制权限未授权，扫描会失败。请到 系统设置 → 隐私与安全性 → 屏幕录制 中允许 谷子助手。
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="权限状态">
        {perms && (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span>屏幕录制（截图捕获其他应用内容需要）</span>
              <span
                className={`text-xs ${perms.screen === 'granted' ? 'text-emerald-600' : 'text-amber-600'}`}
              >
                {perms.screen === 'granted' ? '已授权' : `未授权（${perms.screen}）`}
              </span>
            </div>
            <button
              className="mt-1 self-start rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
              onClick={loadPerms}
            >
              刷新状态
            </button>
          </div>
        )}
      </Section>
          </>
        )}
        {cat === '数据' && (
          <>
      <Section title="数据导出">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          导出指定时间范围内的工作记录、日报、应用使用时长与屏幕识别历史为 JSON 文件。
        </p>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            value={exportFrom}
            onChange={(e) => setExportFrom(e.target.value)}
          />
          <span className="text-slate-400">至</span>
          <input
            type="date"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
            value={exportTo}
            onChange={(e) => setExportTo(e.target.value)}
          />
          <button
            className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-50"
            disabled={!exportFrom || !exportTo || exportFrom > exportTo}
            onClick={async () => {
              const ok = await api.exportRange(exportFrom, exportTo)
              if (ok) flash('已导出')
            }}
          >
            导出 JSON
          </button>
        </div>
      </Section>
      <Section title="数据管理">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          所有数据仅保存在本机（用户目录下的 SQLite 数据库），不会自动上传。提交解析时，所选内容会发送至 谷子助手 云端解析服务。
        </p>
        <div className="flex gap-2">
          <button
            className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            onClick={() => void wipeMemory()}
          >
            清空所有记忆
          </button>
          <button
            className="rounded-lg border border-red-200 px-4 py-1.5 text-xs text-red-600 hover:bg-red-50"
            onClick={() => void wipe()}
          >
            清除全部数据
          </button>
        </div>
      </Section>
          </>
        )}
        {cat === '关于' && (
          <>
            <Section title="版本">
              <div className="flex items-center gap-3 text-sm">
                <span className="text-slate-500">当前版本 {appVersion || '…'}</span>
                <button
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  disabled={checkingUpdate}
                  onClick={async () => {
                    setCheckingUpdate(true)
                    try {
                      await api.checkUpdate() // 结果由系统对话框反馈
                    } finally {
                      setCheckingUpdate(false)
                    }
                  }}
                >
                  {checkingUpdate ? '检查中…' : '检查更新'}
                </button>
              </div>
            </Section>
            <FeedbackSection />
          </>
        )}
      </div>

      {note && (
        <div
          key={note}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2 text-sm text-white shadow-lg"
        >
          {note}
        </div>
      )}
    </div>
  )
}
