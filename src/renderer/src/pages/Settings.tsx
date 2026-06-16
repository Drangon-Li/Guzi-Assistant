import { useEffect, useState } from 'react'
import type { AppSettings, FeishuStatus, PermissionStatus, Profile } from '@shared/types'
import { api } from '../api'
import { CONFIRM_MODES, formatHotkey } from '../labels'

interface Props {
  onProfileChange: (p: Profile) => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

const PRESET_HOTKEYS = ['Alt+C', 'Alt+Space', 'CommandOrControl+Shift+C']

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

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export default function Settings({ onProfileChange }: Props): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [perms, setPerms] = useState<PermissionStatus | null>(null)
  const [note, setNote] = useState('')
  const [recording, setRecording] = useState(false)
  const [scanRecording, setScanRecording] = useState(false)
  const [qaInstalled, setQaInstalled] = useState(false)
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null)

  const loadPerms = (): void => {
    void api.permissions().then(setPerms)
  }

  useEffect(() => {
    void api.getProfile().then(setProfile)
    void api.getSettings().then(setSettings)
    void api.quickActionStatus().then(setQaInstalled)
    void api.feishuStatus().then(setFeishu)
    loadPerms()
  }, [])

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2500)
  }

  const applyHotkey = async (acc: string): Promise<void> => {
    const ok = await api.saveSettings({ hotkey: acc })
    if (ok) {
      setSettings((s) => (s ? { ...s, hotkey: acc } : s))
      flash(`快捷键已设为 ${formatHotkey(acc)}`)
    } else {
      flash('注册失败：该组合可能被系统或其他应用占用')
    }
  }

  const applyScanHotkey = async (acc: string): Promise<void> => {
    await api.saveSettings({ screenSenseHotkey: acc })
    setSettings((s) => (s ? { ...s, screenSenseHotkey: acc } : s))
    flash(`扫描快捷键已设为 ${formatHotkey(acc)}`)
  }

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const acc = eventToAccelerator(e)
      if (!acc) return
      setRecording(false)
      void applyHotkey(acc)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  useEffect(() => {
    if (!scanRecording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setScanRecording(false)
        return
      }
      const acc = eventToAccelerator(e)
      if (!acc) return
      setScanRecording(false)
      void applyScanHotkey(acc)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [scanRecording])

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

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8 pb-16">
      <h1 className="text-lg font-semibold">设置</h1>

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
                  ? 'border-slate-300 bg-slate-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <div className="text-xs text-slate-400">{m.desc}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="快捷键">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">提交剪切板</span>
          <button
            onClick={() => setRecording(!recording)}
            className={`min-w-44 rounded-lg border px-4 py-2 font-medium ${
              recording
                ? 'animate-pulse border-slate-400 bg-slate-50 text-slate-700'
                : 'border-slate-300 hover:border-slate-400'
            }`}
          >
            {recording ? '按下新组合键…' : formatHotkey(settings.hotkey)}
          </button>
          {recording && <span className="text-xs text-slate-400">Esc 取消</span>}
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-400">
          点击按键框后直接按下想要的组合：需包含至少一个修饰键（⌘ ⌥ ⌃ ⇧），F1–F12
          可单独使用。注册失败说明该组合被系统或其他应用占用。
        </p>
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          常用：
          {PRESET_HOTKEYS.map((acc) => (
            <button
              key={acc}
              onClick={() => void applyHotkey(acc)}
              className={`rounded-lg border px-2 py-1 ${
                settings.hotkey === acc
                  ? 'border-slate-300 bg-slate-50 text-slate-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              {formatHotkey(acc)}
            </button>
          ))}
        </div>
      </Section>

      <Section title="系统集成">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div>访达右键快速操作</div>
              <div className="mt-0.5 text-xs leading-5 text-slate-400">
                安装后在访达中选中文件 → 右键 → 快速操作 → 「发送到 纸壳助手」，文件会直接进入解析流程（应用未运行时会在下次启动时补处理）。
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
              把文件直接拖到菜单栏的 纸壳助手 图标上即可提交解析，无需安装。
            </div>
          </div>
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
            className="rounded-lg bg-ink px-4 py-1.5 text-xs text-white hover:bg-black"
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

      <Section title="屏幕感知建议（隐私功能）">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          开启后可手动「扫描当前屏幕」：纸壳助手 在本机识别屏幕上的文字，命中关键词时把文字（非截图）送解析，
          给出一条待办建议供你确认。截图用完即弃、不保存、不上传。注意：macOS
          会在你扫描时显示系统录制指示器，这是系统强制行为、无法关闭。首次使用会自动编译本地 OCR 组件（需 Xcode
          命令行工具）。
        </p>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>启用屏幕感知建议</span>
          <input
            type="checkbox"
            checked={settings.screenSenseEnabled}
            onChange={async (e) => {
              const next = e.target.checked
              setSettings({ ...settings, screenSenseEnabled: next })
              await api.saveSettings({ screenSenseEnabled: next })
              flash(next ? '已开启屏幕感知建议' : '已关闭屏幕感知建议')
            }}
          />
        </label>

        {settings.screenSenseEnabled && (
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-slate-500">触发关键词（逗号或顿号分隔）</span>
              <input
                className={input}
                defaultValue={settings.screenSenseKeywords.join('、')}
                onBlur={async (e) => {
                  const list = splitList(e.target.value)
                  setSettings({ ...settings, screenSenseKeywords: list })
                  await api.saveSettings({ screenSenseKeywords: list })
                  flash('关键词已保存')
                }}
              />
            </label>

            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-500">扫描快捷键</span>
              <button
                onClick={() => setScanRecording(!scanRecording)}
                className={`min-w-44 rounded-lg border px-4 py-2 font-medium ${
                  scanRecording
                    ? 'animate-pulse border-slate-400 bg-slate-50 text-slate-700'
                    : 'border-slate-300 hover:border-slate-400'
                }`}
              >
                {scanRecording ? '按下新组合键…' : formatHotkey(settings.screenSenseHotkey)}
              </button>
              {scanRecording && <span className="text-xs text-slate-400">Esc 取消</span>}
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
                    <span className="text-slate-500">检查间隔</span>
                    <input
                      type="number"
                      min={2}
                      max={60}
                      className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                      value={settings.screenSenseIntervalSec}
                      onChange={(e) =>
                        setSettings({ ...settings, screenSenseIntervalSec: Number(e.target.value) })
                      }
                      onBlur={async (e) => {
                        const v = Math.min(60, Math.max(2, Number(e.target.value) || 5))
                        setSettings({ ...settings, screenSenseIntervalSec: v })
                        await api.saveSettings({ screenSenseIntervalSec: v })
                        flash('已保存监控间隔')
                      }}
                    />
                    <span className="text-xs text-slate-400">秒</span>
                  </label>
                  <p className="text-xs leading-5 text-slate-400">
                    屏幕静止时不触发识别与上云；可在菜单栏 纸壳助手 图标随时「暂停屏幕监控」。macOS
                    会持续显示系统录制指示器（无法关闭）。
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
                      这些应用在前台时连截图都不做。中英文名称可都填（如 微信 / WeChat）。
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
                屏幕录制权限未授权，扫描会失败。请到 系统设置 → 隐私与安全性 → 屏幕录制 中允许 纸壳助手。
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

      <Section title="数据管理">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          所有数据仅保存在本机（用户目录下的 SQLite 数据库），不会自动上传。提交解析时，所选内容会发送至 纸壳助手 云端解析服务。
        </p>
        <button
          className="rounded-lg border border-red-200 px-4 py-1.5 text-xs text-red-600 hover:bg-red-50"
          onClick={() => void wipe()}
        >
          清除全部数据
        </button>
      </Section>

      {note && (
        <div
          key={note}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg"
        >
          {note}
        </div>
      )}
    </div>
  )
}
