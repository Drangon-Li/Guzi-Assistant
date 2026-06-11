import { useEffect, useState } from 'react'
import type { AppSettings, HotkeyMode, Identity, PermissionStatus, Profile } from '@shared/types'
import { api } from '../api'
import { CONFIRM_MODES, IDENTITIES } from '../labels'

interface Props {
  onProfileChange: (p: Profile) => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none'

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
  const [nicknames, setNicknames] = useState('')
  const [accounts, setAccounts] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [perms, setPerms] = useState<PermissionStatus | null>(null)
  const [note, setNote] = useState('')

  const loadPerms = (): void => {
    void api.permissions().then(setPerms)
  }

  useEffect(() => {
    void api.getProfile().then((p) => {
      setProfile(p)
      if (p) {
        setNicknames(p.nicknames.join('、'))
        setAccounts(p.accounts.join('、'))
      }
    })
    void api.getSettings().then(setSettings)
    loadPerms()
  }, [])

  if (!profile || !settings) return <div className="p-8 text-sm text-slate-400">加载中…</div>

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2500)
  }

  const saveProfile = async (next: Profile): Promise<void> => {
    setProfile(next)
    await api.saveProfile(next)
    onProfileChange(next)
  }

  const saveProfileForm = async (): Promise<void> => {
    if (!profile.name.trim()) return
    await saveProfile({
      ...profile,
      name: profile.name.trim(),
      nicknames: splitList(nicknames),
      accounts: splitList(accounts)
    })
    flash('档案已保存')
  }

  const setHotkey = async (mode: HotkeyMode): Promise<void> => {
    setSettings({ ...settings, hotkeyMode: mode })
    await api.saveSettings({ hotkeyMode: mode })
    loadPerms()
  }

  const saveApi = async (): Promise<void> => {
    await api.saveSettings({
      apiBase: settings.apiBase.trim(),
      apiKey: settings.apiKey.trim(),
      model: settings.model.trim()
    })
    loadPerms()
    flash('API 配置已保存')
  }

  const wipe = async (): Promise<void> => {
    if (!window.confirm('将删除所有任务、来源和用户档案，无法恢复。确定清除？')) return
    await api.wipeData()
    window.location.reload()
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8 pb-16">
      <h1 className="text-lg font-semibold">设置</h1>

      <Section title="用户档案">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">真实姓名 *</span>
            <input
              className={input}
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">身份类型</span>
            <select
              className={input}
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
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">常用昵称 / 英文名</span>
            <input className={input} value={nicknames} onChange={(e) => setNicknames(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">常用账号名</span>
            <input className={input} value={accounts} onChange={(e) => setAccounts(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">组织 / 学校 / 公司</span>
            <input
              className={input}
              value={profile.org}
              onChange={(e) => setProfile({ ...profile, org: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">班级 / 课题组 / 岗位</span>
            <input
              className={input}
              value={profile.group}
              onChange={(e) => setProfile({ ...profile, group: e.target.value })}
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-slate-500">工作 / 学习时间偏好</span>
            <input
              className={input}
              value={profile.workHours}
              onChange={(e) => setProfile({ ...profile, workHours: e.target.value })}
            />
          </label>
        </div>
        <div className="mt-4">
          <button
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs text-white hover:bg-indigo-700"
            onClick={() => void saveProfileForm()}
          >
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
              className={`rounded-xl border px-4 py-2.5 text-left ${
                profile.confirmMode === m.value
                  ? 'border-indigo-400 bg-indigo-50'
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
        <div className="flex flex-col gap-2">
          <button
            onClick={() => void setHotkey('space_c')}
            className={`rounded-xl border px-4 py-2.5 text-left ${
              settings.hotkeyMode === 'space_c'
                ? 'border-indigo-400 bg-indigo-50'
                : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="text-sm font-medium">按住 Space 再按 C（默认）</div>
            <div className="text-xs leading-5 text-slate-400">
              需要 macOS 辅助功能权限。注意：若焦点在其他应用的输入框，空格和 c 仍会被输入。
            </div>
          </button>
          <button
            onClick={() => void setHotkey('alt_space')}
            className={`rounded-xl border px-4 py-2.5 text-left ${
              settings.hotkeyMode === 'alt_space'
                ? 'border-indigo-400 bg-indigo-50'
                : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="text-sm font-medium">Option + Space</div>
            <div className="text-xs text-slate-400">无输入副作用；与 Space+C 冲突时的推荐备选。</div>
          </button>
        </div>
      </Section>

      <Section title="权限状态">
        {perms && (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span>辅助功能（Space+C 全局监听需要）</span>
              {perms.accessibility ? (
                <span className="text-xs text-emerald-600">已授权</span>
              ) : (
                <button
                  className="rounded-lg border border-amber-300 px-2 py-1 text-xs text-amber-600 hover:bg-amber-50"
                  onClick={() => void api.openAccessibility()}
                >
                  未授权，去系统设置开启
                </button>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span>屏幕录制（截图捕获其他应用内容需要）</span>
              <span
                className={`text-xs ${perms.screen === 'granted' ? 'text-emerald-600' : 'text-amber-600'}`}
              >
                {perms.screen === 'granted' ? '已授权' : `未授权（${perms.screen}）`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>解析 API</span>
              <span className={`text-xs ${perms.apiConfigured ? 'text-emerald-600' : 'text-red-500'}`}>
                {perms.apiConfigured ? '已配置' : '未配置'}
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

      <Section title="解析 API">
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Base URL</span>
            <input
              className={input}
              value={settings.apiBase}
              onChange={(e) => setSettings({ ...settings, apiBase: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">模型</span>
              <input
                className={input}
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-500">API Key</span>
              <input
                type="password"
                className={input}
                value={settings.apiKey}
                onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
              />
            </label>
          </div>
          <button
            className="self-start rounded-lg bg-indigo-600 px-4 py-1.5 text-xs text-white hover:bg-indigo-700"
            onClick={() => void saveApi()}
          >
            保存 API 配置
          </button>
        </div>
      </Section>

      <Section title="数据管理">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          所有数据仅保存在本机（用户目录下的 SQLite 数据库），不会自动上传。提交解析时，所选内容会发送给你配置的解析
          API。
        </p>
        <button
          className="rounded-lg border border-red-200 px-4 py-1.5 text-xs text-red-600 hover:bg-red-50"
          onClick={() => void wipe()}
        >
          清除全部数据
        </button>
      </Section>

      {note && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {note}
        </div>
      )}
    </div>
  )
}
