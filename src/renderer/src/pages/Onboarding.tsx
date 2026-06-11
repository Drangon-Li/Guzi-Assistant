import { useState } from 'react'
import type { ConfirmMode, Identity, Profile } from '@shared/types'
import { api } from '../api'
import { CONFIRM_MODES, IDENTITIES } from '../labels'

interface Props {
  onDone: (p: Profile) => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none'

function splitList(s: string): string[] {
  return s
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

export default function Onboarding({ onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [nicknames, setNicknames] = useState('')
  const [accounts, setAccounts] = useState('')
  const [identity, setIdentity] = useState<Identity>('student')
  const [org, setOrg] = useState('')
  const [group, setGroup] = useState('')
  const [workHours, setWorkHours] = useState('')
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>('standard')

  const finish = async (): Promise<void> => {
    const profile: Profile = {
      name: name.trim(),
      nicknames: splitList(nicknames),
      accounts: splitList(accounts),
      identity,
      org: org.trim(),
      group: group.trim(),
      workHours: workHours.trim(),
      confirmMode
    }
    await api.saveProfile(profile)
    onDone(profile)
  }

  return (
    <div className="flex h-full items-center justify-center bg-slate-100">
      <div className="w-[520px] rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="text-xl font-bold">欢迎使用 al1</div>
        <p className="mt-1 text-xs leading-5 text-slate-400">
          al1 需要一份最小档案来判断「哪些事是你的事」。约 2 分钟完成，所有选填项都可以跳过。
        </p>

        <div className="mt-4 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-indigo-500' : 'bg-slate-200'}`}
            />
          ))}
        </div>

        <div className="mt-6 flex min-h-[260px] flex-col gap-4">
          {step === 0 && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600">
                  真实姓名 <span className="text-red-500">*</span>
                  <span className="ml-2 text-xs text-slate-400">用于识别通知中点名你的任务</span>
                </span>
                <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600">
                  常用昵称 / 英文名
                  <span className="ml-2 text-xs text-slate-400">多个用逗号分隔，识别群聊里的别名</span>
                </span>
                <input
                  className={input}
                  value={nicknames}
                  onChange={(e) => setNicknames(e.target.value)}
                  placeholder="如：小李, Leo"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600">
                  常用账号名
                  <span className="ml-2 text-xs text-slate-400">社交软件用户名、邮箱前缀、GitHub 等</span>
                </span>
                <input
                  className={input}
                  value={accounts}
                  onChange={(e) => setAccounts(e.target.value)}
                  placeholder="如：lisi2024"
                />
              </label>
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-sm text-slate-600">
                  身份类型 <span className="text-red-500">*</span>
                </span>
                {IDENTITIES.map((it) => (
                  <button
                    key={it.value}
                    onClick={() => setIdentity(it.value)}
                    className={`rounded-xl border px-4 py-2.5 text-left ${
                      identity === it.value
                        ? 'border-indigo-400 bg-indigo-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="text-sm font-medium">{it.label}</div>
                    <div className="text-xs text-slate-400">{it.desc}</div>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-600">组织 / 学校 / 公司</span>
                  <input className={input} value={org} onChange={(e) => setOrg(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-600">班级 / 课题组 / 岗位</span>
                  <input className={input} value={group} onChange={(e) => setGroup(e.target.value)} />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-600">工作 / 学习时间偏好</span>
                <input
                  className={input}
                  value={workHours}
                  onChange={(e) => setWorkHours(e.target.value)}
                  placeholder="如：工作日 9:00 - 22:00"
                />
              </label>
            </>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm text-slate-600">
                确认模式 <span className="text-red-500">*</span>
                <span className="ml-2 text-xs text-slate-400">决定 AI 发现的任务如何进入日程</span>
              </span>
              {CONFIRM_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setConfirmMode(m.value)}
                  className={`rounded-xl border px-4 py-3 text-left ${
                    confirmMode === m.value
                      ? 'border-indigo-400 bg-indigo-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="text-xs leading-5 text-slate-400">{m.desc}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-between">
          <button
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-100 disabled:invisible"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
          >
            上一步
          </button>
          {step < 2 ? (
            <button
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-40"
              disabled={step === 0 && !name.trim()}
              onClick={() => setStep(step + 1)}
            >
              下一步
            </button>
          ) : (
            <button
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm text-white hover:bg-indigo-700"
              onClick={() => void finish()}
            >
              开始使用
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
