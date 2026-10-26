// 设置页「通用」分区。状态仍由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, LaunchAtLoginState, Profile } from '@shared/types'
import { api } from '../../api'
import { CONFIRM_MODES, formatHotkey } from '../../labels'
import { isMac } from '../../platform'
import { Section, Toggle } from '../ui'

interface Props {
  profile: Profile
  settings: AppSettings
  saveSettings: (patch: Partial<AppSettings>) => Promise<boolean>
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  flash: (msg: string) => void
  saveProfile: (next: Profile) => Promise<void>
}

export default function GeneralSection({
  profile, settings, setSettings, flash, saveProfile, saveSettings
}: Props): React.JSX.Element {
  // 开机自启不进 settings 表：真值在系统登录项里，单独读
  const [launch, setLaunch] = useState<LaunchAtLoginState | null>(null)
  useEffect(() => {
    void api.launchAtLogin().then(setLaunch)
  }, [])

  return (
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
                void saveSettings({ theme: t.v })
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

      <Section title="启动">
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            开机自动启动
            <span className="ml-2 text-xs text-slate-400">
              {launch && !launch.supported
                ? '开发环境登记的会是 Electron 本体，装成应用后才可用'
                : launch?.requiresApproval
                  ? '已登记，但被「系统设置 → 通用 → 登录项」拦下，需去那里放行'
                  : '登录后静默启动到托盘，不弹主界面'}
            </span>
          </span>
          <Toggle
            checked={launch?.enabled ?? false}
            disabled={!launch?.supported}
            ariaLabel="开机自动启动"
            onChange={async (next) => {
              const state = await api.setLaunchAtLogin(next)
              setLaunch(state)
              flash(state.enabled ? '开机时会自动启动' : '已关闭开机自启')
            }}
          />
        </label>
      </Section>

      <Section title="任务提醒" desc="到点前弹置顶提醒卡 + 悬浮球气泡 + 系统通知；不点不消失。">
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>开启任务提醒</span>
            <Toggle
              checked={settings.taskReminderEnabled}
              ariaLabel="开启任务提醒"
              onChange={async (next) => {
                setSettings({ ...settings, taskReminderEnabled: next })
                await saveSettings({ taskReminderEnabled: next })
                flash(next ? '任务到点会主动提醒' : '已关闭任务提醒')
              }}
            />
          </label>
          {settings.taskReminderEnabled && (
            <label className="flex items-center gap-3 pl-1 text-sm">
              <span className="text-slate-500">默认提前</span>
              <input
                type="number"
                min={0}
                max={1440}
                className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                value={settings.taskReminderOffsetMin}
                onChange={(e) =>
                  setSettings({ ...settings, taskReminderOffsetMin: Number(e.target.value) })
                }
                onBlur={async (e) => {
                  const v = Math.min(1440, Math.max(0, Number(e.target.value) || 0))
                  setSettings({ ...settings, taskReminderOffsetMin: v })
                  await saveSettings({ taskReminderOffsetMin: v })
                  flash(v ? `任务开始前 ${v} 分钟提醒` : '到点时提醒')
                }}
              />
              <span className="text-xs text-slate-400">分钟，0 = 到点才提醒；单个任务可在详情里单独设</span>
            </label>
          )}
        </div>
      </Section>

      <Section title="剪贴板自动捕获" desc={isMac ? '复制到疑似日程的内容时主动提示。前三道门都不读正文：只在系统判定「像日程」时才第一次读取，密码管理器打了标记的内容一个字都不碰。' : '在本机检查剪贴板的敏感标记与日程时间模式，仅匹配内容进入识别；敏感标记和排除应用的内容会跳过。'}>
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              自动感知剪贴板
              <span className="ml-2 text-xs text-slate-400">
                {isMac ? '需要 macOS 15.4 及以上；' : '本地检测会读取文本；'}{formatHotkey(settings.hotkey)} 手动捕获始终可用
              </span>
            </span>
            <Toggle
              checked={settings.clipWatchEnabled}
              ariaLabel="自动感知剪贴板"
              onChange={async (next) => {
                setSettings({ ...settings, clipWatchEnabled: next })
                await saveSettings({ clipWatchEnabled: next })
                flash(next ? '复制到日程会主动提示' : '已关闭剪贴板自动感知')
              }}
            />
          </label>
          <p className="pl-1 text-xs text-slate-400">
            排除名单与屏幕感知共用：名单里的 App 复制出来的内容不会被解析。
          </p>
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
  )
}
