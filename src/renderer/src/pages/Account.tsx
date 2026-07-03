import { useEffect, useState } from 'react'
import type { Identity, Profile } from '@shared/types'
import { api } from '../api'
import { IDENTITIES, IDENTITY_PROFILE_FIELDS } from '../labels'
import AccountSection from '../components/AccountSection'
import PersonalMemory from '../components/PersonalMemory'

interface Props {
  onProfileChange: (p: Profile) => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

function splitList(s: string): string[] {
  return s
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export default function Account({ onProfileChange }: Props): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [nicknames, setNicknames] = useState('')
  const [accounts, setAccounts] = useState('')
  const [notMine, setNotMine] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    void api.getProfile().then((p) => {
      setProfile(p)
      if (p) {
        setNicknames(p.nicknames.join('、'))
        setAccounts(p.accounts.join('、'))
        setNotMine((p.belongingNotMine ?? []).join('、'))
      }
    })
  }, [])

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2500)
  }

  if (!profile) return <div className="p-8 text-sm text-slate-400">加载中…</div>

  // 档案字段呈现随身份类型即时切换（学生→学校/课题组，职场→公司/部门，自由职业→客户/业务方向）
  const fields = IDENTITY_PROFILE_FIELDS[profile.identity]

  const saveProfileForm = async (): Promise<void> => {
    if (!profile.name.trim()) {
      flash('真实姓名不能为空')
      return
    }
    const next: Profile = {
      ...profile,
      name: profile.name.trim(),
      nicknames: splitList(nicknames),
      accounts: splitList(accounts),
      belongingNotMine: splitList(notMine)
    }
    setProfile(next)
    await api.saveProfile(next)
    onProfileChange(next)
    flash('档案已保存')
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8 pb-16">
      <h1 className="text-lg font-semibold">个人</h1>

      <Section title="账户">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          解析能力由 谷子助手 云端提供，登录即用，无需配置模型或密钥。
        </p>
        <AccountSection />
      </Section>

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
            <span className="text-xs text-slate-400">
              会重点留意：{IDENTITIES.find((it) => it.value === profile.identity)?.desc}
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">常用昵称 / 英文名</span>
            <input className={input} value={nicknames} onChange={(e) => setNicknames(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">常用账号名</span>
            <input className={input} value={accounts} onChange={(e) => setAccounts(e.target.value)} />
          </label>
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-slate-500">
              通常不是我的称呼 / 账号 / 角色
              <span className="ml-2 text-xs text-slate-400">顿号分隔；帮助判断「哪些不是你的事」</span>
            </span>
            <input
              className={input}
              value={notMine}
              onChange={(e) => setNotMine(e.target.value)}
              placeholder={fields.notMinePlaceholder}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">{fields.org.label}</span>
            <input
              className={input}
              value={profile.org}
              onChange={(e) => setProfile({ ...profile, org: e.target.value })}
              placeholder={fields.org.placeholder}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">{fields.group.label}</span>
            <input
              className={input}
              value={profile.group}
              onChange={(e) => setProfile({ ...profile, group: e.target.value })}
              placeholder={fields.group.placeholder}
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-slate-500">{fields.workHours.label}</span>
            <input
              className={input}
              value={profile.workHours}
              onChange={(e) => setProfile({ ...profile, workHours: e.target.value })}
              placeholder={fields.workHours.placeholder}
            />
          </label>
        </div>
        <div className="mt-4">
          <button
            className="rounded-lg bg-brand px-4 py-1.5 text-xs text-white hover:bg-brand-dark"
            onClick={() => void saveProfileForm()}
          >
            保存档案
          </button>
        </div>
      </Section>

      <Section title="个人记忆">
        <p className="mb-4 text-xs leading-5 text-slate-400">
          归纳「你是谁、最近在做什么」，让助手越用越懂你。全部本地，不上传。
        </p>
        <PersonalMemory />
      </Section>

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
