import { useState } from 'react'
import type { ConfirmMode, Identity, Profile } from '@shared/types'
import { api } from '../api'
import { CONFIRM_MODES, IDENTITIES } from '../labels'

interface Props {
  onDone: (p: Profile) => void
}

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
    <div className="ob-wrap">
      <div className="ob-card animate-page">
        <div className="h">欢迎使用 纸壳助手</div>
        <div className="p">
          纸壳助手 需要一份最小档案来判断「哪些事是你的事」。约 2 分钟完成，所有选填项都可以跳过。
        </div>

        <div className="steps">
          {[0, 1, 2].map((i) => (
            <i key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>

        <div key={step} className="ob-body animate-page">
          {step === 0 && (
            <>
              <div className="field">
                <span>
                  真实姓名 <span style={{ color: 'var(--danger)' }}>*</span>
                  <span style={{ marginLeft: 6, color: 'var(--t4)' }}>用于识别通知中点名你的任务</span>
                </span>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：李思" />
              </div>
              <div className="field">
                <span>
                  常用昵称 / 英文名
                  <span style={{ marginLeft: 6, color: 'var(--t4)' }}>多个用逗号分隔，识别群聊里的别名</span>
                </span>
                <input
                  type="text"
                  value={nicknames}
                  onChange={(e) => setNicknames(e.target.value)}
                  placeholder="如：小李, Leo"
                />
              </div>
              <div className="field">
                <span>
                  常用账号名
                  <span style={{ marginLeft: 6, color: 'var(--t4)' }}>社交软件用户名、邮箱前缀、GitHub 等</span>
                </span>
                <input
                  type="text"
                  value={accounts}
                  onChange={(e) => setAccounts(e.target.value)}
                  placeholder="如：lisi2024"
                />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="field">
                <span>
                  身份类型 <span style={{ color: 'var(--danger)' }}>*</span>
                </span>
              </div>
              {IDENTITIES.map((it) => (
                <button
                  key={it.value}
                  className={identity === it.value ? 'opt on' : 'opt'}
                  onClick={() => setIdentity(it.value)}
                >
                  <div className="ol">{it.label}</div>
                  <div className="od">{it.desc}</div>
                </button>
              ))}
              <div className="grid2">
                <div className="field">
                  <span>组织 / 学校 / 公司</span>
                  <input type="text" value={org} onChange={(e) => setOrg(e.target.value)} />
                </div>
                <div className="field">
                  <span>班级 / 课题组 / 岗位</span>
                  <input type="text" value={group} onChange={(e) => setGroup(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <span>工作 / 学习时间偏好</span>
                <input
                  type="text"
                  value={workHours}
                  onChange={(e) => setWorkHours(e.target.value)}
                  placeholder="如：工作日 9:00 - 22:00"
                />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="field">
                <span>
                  确认模式 <span style={{ color: 'var(--danger)' }}>*</span>
                  <span style={{ marginLeft: 6, color: 'var(--t4)' }}>决定 AI 发现的任务如何进入日程</span>
                </span>
              </div>
              {CONFIRM_MODES.map((m) => (
                <button
                  key={m.value}
                  className={confirmMode === m.value ? 'opt on' : 'opt'}
                  onClick={() => setConfirmMode(m.value)}
                >
                  <div className="ol">{m.label}</div>
                  <div className="od">{m.desc}</div>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="ob-foot">
          <button
            className="btn ghost"
            style={step === 0 ? { visibility: 'hidden' } : undefined}
            onClick={() => setStep(step - 1)}
          >
            上一步
          </button>
          {step < 2 ? (
            <button
              className="btn primary"
              disabled={step === 0 && !name.trim()}
              onClick={() => setStep(step + 1)}
            >
              下一步
            </button>
          ) : (
            <button className="btn primary" onClick={() => void finish()}>
              开始使用
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
