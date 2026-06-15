import { useEffect, useState } from 'react'
import type { AppSettings, FeishuStatus, Identity, PermissionStatus, Profile } from '@shared/types'
import { api } from '../api'
import { CONFIRM_MODES, formatHotkey, IDENTITIES } from '../labels'
import AccountSection from '../components/AccountSection'

interface Props {
  onProfileChange: (p: Profile) => void
}


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
    <div className="section">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

export default function Settings({ onProfileChange }: Props): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [nicknames, setNicknames] = useState('')
  const [accounts, setAccounts] = useState('')
  const [notMine, setNotMine] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [perms, setPerms] = useState<PermissionStatus | null>(null)
  const [note, setNote] = useState('')
  const [scanRecording, setScanRecording] = useState(false)
  const [qaInstalled, setQaInstalled] = useState(false)
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null)

  const loadPerms = (): void => {
    void api.permissions().then(setPerms)
  }

  useEffect(() => {
    void api.getProfile().then((p) => {
      setProfile(p)
      if (p) {
        setNicknames(p.nicknames.join('、'))
        setAccounts(p.accounts.join('、'))
        setNotMine((p.belongingNotMine ?? []).join('、'))
      }
    })
    void api.getSettings().then(setSettings)
    void api.quickActionStatus().then(setQaInstalled)
    void api.feishuStatus().then(setFeishu)
    loadPerms()
  }, [])

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2500)
  }

  const applyScanHotkey = async (acc: string): Promise<void> => {
    await api.saveSettings({ screenSenseHotkey: acc })
    setSettings((s) => (s ? { ...s, screenSenseHotkey: acc } : s))
    flash(`扫描快捷键已设为 ${formatHotkey(acc)}`)
  }

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

  if (!profile || !settings) return <div className="p-8" style={{ fontSize: 13, color: 'var(--t3)' }}>加载中…</div>

  const saveProfile = async (next: Profile): Promise<void> => {
    setProfile(next)
    await api.saveProfile(next)
    onProfileChange(next)
  }

  const saveProfileForm = async (): Promise<void> => {
    if (!profile.name.trim()) {
      flash('真实姓名不能为空')
      return
    }
    await saveProfile({
      ...profile,
      name: profile.name.trim(),
      nicknames: splitList(nicknames),
      accounts: splitList(accounts),
      belongingNotMine: splitList(notMine)
    })
    flash('档案已保存')
  }

  const wipe = async (): Promise<void> => {
    if (!window.confirm('将删除所有任务、来源和用户档案，无法恢复。确定清除？')) return
    await api.wipeData()
    window.location.reload()
  }

  return (
    <div className="page animate-page" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 48 }}>
      <div className="page-title">设置</div>

      <Section title="账户与服务">
        <AccountSection />
      </Section>

      <Section title="用户档案">
        <div className="grid2">
          <label className="field">
            <span>真实姓名 *</span>
            <input
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>身份类型</span>
            <select
              value={profile.identity}
              onChange={(e) => setProfile({ ...profile, identity: e.target.value as Identity })}
            >
              {IDENTITIES.map((it) => (
                <option key={it.value} value={it.value}>
                  {it.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>常用昵称 / 英文名</span>
            <input value={nicknames} onChange={(e) => setNicknames(e.target.value)} />
          </label>
          <label className="field">
            <span>组织 / 学校</span>
            <input
              value={profile.org}
              onChange={(e) => setProfile({ ...profile, org: e.target.value })}
            />
          </label>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="btn primary sm" onClick={() => void saveProfileForm()}>
            保存档案
          </button>
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
              style={{
                borderRadius: 'var(--r-md)',
                border: '1px solid',
                borderColor: profile.confirmMode === m.value ? 'var(--line)' : 'var(--line-2)',
                background: profile.confirmMode === m.value ? 'var(--hover)' : 'transparent',
                padding: '10px 14px',
                textAlign: 'left',
                cursor: 'pointer'
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t1)' }}>{m.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{m.desc}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="系统集成">
        <div className="flex flex-col gap-3" style={{ fontSize: 13 }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div style={{ color: 'var(--t1)' }}>访达右键快速操作</div>
              <div className="desc" style={{ marginTop: 2 }}>
                安装后在访达中选中文件 → 右键 → 快速操作 → 「发送到 纸壳助手」，文件会直接进入解析流程（应用未运行时会在下次启动时补处理）。
              </div>
            </div>
            <button
              className="btn outline sm"
              style={{ flexShrink: 0 }}
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
            <div style={{ color: 'var(--t1)' }}>托盘拖拽</div>
            <div className="desc" style={{ marginTop: 2 }}>
              把文件直接拖到菜单栏的 纸壳助手 图标上即可提交解析，无需安装。
            </div>
          </div>
        </div>
      </Section>

      <Section title="飞书机器人">
        <p className="desc">
          在飞书里把通知/截图直接转发给机器人，自动进入待确认列表。配置步骤：飞书开放平台（open.feishu.cn）创建企业自建应用
          → 添加「机器人」能力 → 权限开通 im:message（接收与发送单聊消息）→ 事件订阅选择「使用长连接接收事件」并添加
          im.message.receive_v1 → 创建版本发布。无需公网服务器。
        </p>
        <div className="grid2" style={{ marginTop: 12 }}>
          <label className="field">
            <span>App ID</span>
            <input
              value={settings.feishuAppId}
              onChange={(e) => setSettings({ ...settings, feishuAppId: e.target.value })}
              placeholder="cli_xxx"
            />
          </label>
          <label className="field">
            <span>App Secret</span>
            <input
              type="password"
              value={settings.feishuAppSecret}
              onChange={(e) => setSettings({ ...settings, feishuAppSecret: e.target.value })}
            />
          </label>
        </div>
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="btn primary sm"
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
            className="btn outline sm"
            onClick={() => void api.feishuStatus().then(setFeishu)}
          >
            刷新状态
          </button>
          {feishu && (
            <span
              className={feishu.status === 'connected' ? 'ok' : 'muted-s'}
              style={
                feishu.status === 'error'
                  ? { color: 'var(--danger)' }
                  : feishu.status === 'connecting'
                    ? { color: 'var(--warn)', fontSize: 11.5 }
                    : undefined
              }
            >
              {feishu.status === 'connected' && '● 已连接'}
              {feishu.status === 'connecting' && '连接中…'}
              {feishu.status === 'disabled' && '未配置'}
              {feishu.status === 'error' && `连接失败：${feishu.detail}`}
              {feishu.status === 'restart_required' && feishu.detail}
            </span>
          )}
        </div>
      </Section>

      <Section title="屏幕感知建议（隐私功能）">
        <p className="desc">
          开启后可手动「扫描当前屏幕」：纸壳助手 在本机识别屏幕上的文字，命中关键词时把文字（非截图）送解析，
          给出一条待办建议供你确认。截图用完即弃、不保存、不上传。注意：macOS
          会在你扫描时显示系统录制指示器，这是系统强制行为、无法关闭。首次使用会自动编译本地 OCR 组件（需 Xcode
          命令行工具）。
        </p>
        <label className="flex items-center justify-between gap-4" style={{ fontSize: 13, marginTop: 12 }}>
          <span style={{ color: 'var(--t1)' }}>启用屏幕感知建议</span>
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
          <div className="flex flex-col gap-4" style={{ marginTop: 14 }}>
            <label className="field">
              <span>触发关键词（逗号或顿号分隔）</span>
              <input
                defaultValue={settings.screenSenseKeywords.join('、')}
                onBlur={async (e) => {
                  const list = splitList(e.target.value)
                  setSettings({ ...settings, screenSenseKeywords: list })
                  await api.saveSettings({ screenSenseKeywords: list })
                  flash('关键词已保存')
                }}
              />
            </label>

            <div className="flex items-center gap-3" style={{ fontSize: 13 }}>
              <span style={{ color: 'var(--t2)' }}>扫描快捷键</span>
              <button
                onClick={() => setScanRecording(!scanRecording)}
                style={{
                  minWidth: 176,
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid',
                  borderColor: scanRecording ? 'var(--line)' : 'var(--line-2)',
                  background: scanRecording ? 'var(--hover)' : 'transparent',
                  color: 'var(--t1)',
                  padding: '7px 14px',
                  fontWeight: 500,
                  cursor: 'pointer'
                }}
                className={scanRecording ? 'animate-pulse' : ''}
              >
                {scanRecording ? '按下新组合键…' : formatHotkey(settings.screenSenseHotkey)}
              </button>
              {scanRecording && <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>Esc 取消</span>}
            </div>

            <div style={{ borderTop: '1px solid var(--line-2)', paddingTop: 14 }}>
              <label className="flex items-center justify-between gap-4" style={{ fontSize: 13 }}>
                <span style={{ color: 'var(--t1)' }}>
                  持续监控（自动）
                  <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--t3)' }}>屏幕变化时自动识别，无需手动扫描</span>
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
                <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
                  <label className="flex items-center gap-3" style={{ fontSize: 13 }}>
                    <span style={{ color: 'var(--t2)' }}>检查间隔</span>
                    <input
                      type="number"
                      min={2}
                      max={60}
                      style={{ width: 72 }}
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
                    <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>秒</span>
                  </label>
                  <p className="desc">
                    屏幕静止时不触发识别与上云；可在菜单栏 纸壳助手 图标随时「暂停屏幕监控」。macOS
                    会持续显示系统录制指示器（无法关闭）。
                  </p>
                  <label className="field" style={{ marginTop: 4 }}>
                    <span>不监控的应用（逗号或顿号分隔）</span>
                    <input
                      placeholder="如：1Password、微信、网银"
                      defaultValue={settings.screenSenseExcludedApps.join('、')}
                      onBlur={async (e) => {
                        const list = splitList(e.target.value)
                        setSettings({ ...settings, screenSenseExcludedApps: list })
                        await api.saveSettings({ screenSenseExcludedApps: list })
                        flash('已保存应用排除名单')
                      }}
                    />
                    <span>这些应用在前台时连截图都不做。中英文名称可都填（如 微信 / WeChat）。</span>
                  </label>

                  <div style={{ marginTop: 8, borderTop: '1px solid var(--line-2)', paddingTop: 12 }}>
                    <label className="flex items-center justify-between gap-4" style={{ fontSize: 13 }}>
                      <span style={{ color: 'var(--t1)' }}>
                        保存截图到可搜索记忆
                        <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--t3)' }}>本地加密保存，可在「记忆」里回看</span>
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
                      <label className="flex items-center gap-3" style={{ fontSize: 13, marginTop: 8 }}>
                        <span style={{ color: 'var(--t2)' }}>保留天数</span>
                        <input
                          type="number"
                          min={0}
                          max={365}
                          style={{ width: 72 }}
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
                        <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>天，到期自动清；0 = 永久</span>
                      </label>
                    )}
                    <p className="desc" style={{ marginTop: 6 }}>
                      默认关闭，保持「截图用完即弃」。开启后仅保存缩略图、用系统钥匙串加密；原图始终不留。
                    </p>
                  </div>
                </div>
              )}
            </div>

            {perms && perms.screen !== 'granted' && (
              <div style={{
                borderRadius: 'var(--r-sm)',
                background: '#fef9ec',
                border: '1px solid var(--line-2)',
                padding: '8px 12px',
                fontSize: 11.5,
                lineHeight: 1.6,
                color: 'var(--warn)'
              }}>
                屏幕录制权限未授权，扫描会失败。请到 系统设置 → 隐私与安全性 → 屏幕录制 中允许 EShell。
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="权限状态">
        {perms && (
          <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
            <div className="flex items-center justify-between">
              <span style={{ color: 'var(--t1)' }}>屏幕录制（截图捕获其他应用内容需要）</span>
              <span className={perms.screen === 'granted' ? 'ok' : 'muted-s'}>
                {perms.screen === 'granted' ? '已授权' : `未授权（${perms.screen}）`}
              </span>
            </div>
            <button
              className="btn outline sm"
              style={{ alignSelf: 'flex-start', marginTop: 4 }}
              onClick={loadPerms}
            >
              刷新状态
            </button>
          </div>
        )}
      </Section>

      <Section title="数据管理">
        <p className="desc">
          所有数据仅保存在本机（用户目录下的 SQLite 数据库），不会自动上传。提交解析时，所选内容会发送至 EShell 云端解析服务。
        </p>
        <button
          className="btn outline sm"
          style={{ marginTop: 14, color: 'var(--danger)', borderColor: 'var(--danger-soft)' }}
          onClick={() => void wipe()}
        >
          清除全部数据
        </button>
      </Section>

      {note && (
        <div
          key={note}
          className="animate-toast"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 50,
            borderRadius: 'var(--r-sm)',
            background: 'var(--ink)',
            color: '#fff',
            padding: '8px 16px',
            fontSize: 13,
            boxShadow: '0 4px 16px rgba(0,0,0,.18)'
          }}
        >
          {note}
        </div>
      )}
    </div>
  )
}
