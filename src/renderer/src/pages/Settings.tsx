import { useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  FeishuStatus,
  PermissionStatus,
  Profile,
  ScreenActivityStatus
} from '@shared/types'
import type { HistoryStatus } from '@shared/history'
import { api } from '../api'
import { trackExitSave, useExitParticipant } from '../exit-lifecycle'
import { formatHotkey } from '../labels'
import AboutSection from '../components/settings/AboutSection'
import AssistantSection from '../components/settings/AssistantSection'
import DataSection from '../components/settings/DataSection'
import GeneralSection from '../components/settings/GeneralSection'
import HotkeySection from '../components/settings/HotkeySection'
import IntegrationSection from '../components/settings/IntegrationSection'
import ScreenSenseSection from '../components/settings/ScreenSenseSection'
import VoiceNotesSection from '../components/settings/VoiceNotesSection'
import { eventToAccelerator, type HotkeyField } from '../components/settings/shared'

// 分区导航；每个分区的渲染在 components/settings/ 下各自一个文件，状态仍集中在本组件。
// 这里只有核心功能的设置：插件的配置在各插件自己的页面里，跟着插件走，
// 停用插件不会在这儿留下一个空分区，用户也不用先想「这是核心还是插件」。
const CATS = ['通用', '快捷键', '助手', '集成', '屏幕感知', '语音纪要', '数据', '关于'] as const

/** 供别处深链到某个分区用（如首页「去设置开启」直接落到屏幕感知） */
export type SettingsCat = (typeof CATS)[number]

interface Props {
  onProfileChange: (p: Profile) => void
  /** 进入设置页时先落在哪个分区；不传则回到「通用」。
   *  App 用 key={shownPage} 重挂本组件，所以每次进来 useState 的初值都会重新求值。 */
  initialCat?: SettingsCat
}

export default function Settings({ onProfileChange, initialCat }: Props): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null)
  const savedProfile = useRef<Profile | null>(null)
  const profileValue = useRef<Profile | null>(null)
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const settingsValue = useRef<AppSettings | null>(null)
  const setSettings = (value: React.SetStateAction<AppSettings | null>): void => {
    const next = typeof value === 'function' ? value(settingsValue.current) : value
    settingsValue.current = next
    setSettingsState(next)
  }
  const savedSettings = useRef<AppSettings | null>(null)
  const settingsQueue = useRef<Promise<unknown>>(Promise.resolve())
  const [perms, setPerms] = useState<PermissionStatus | null>(null)
  const [note, setNote] = useState('')
  const [recordingKey, setRecordingKey] = useState<HotkeyField | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [cat, setCat] = useState<SettingsCat>(initialCat ?? '通用')
  const [qaInstalled, setQaInstalled] = useState(false)
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null)
  const [activityStatus, setActivityStatus] = useState<ScreenActivityStatus | null>(null)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus | null>(null)
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

  const loadHistoryStatus = (): void => {
    void api.historyStatus().then(setHistoryStatus)
  }

  useEffect(() => {
    void api.getProfile().then((value) => {
      savedProfile.current = value
      profileValue.current = value
      setProfile(value)
    })
    void api.appVersion().then(setAppVersion)
    void api.getSettings().then((value) => {
      savedSettings.current = value
      setSettings(value)
    })
    void api.quickActionStatus().then(setQaInstalled)
    void api.feishuStatus().then(setFeishu)
    loadPerms()
    loadActivityStatus()
    loadHistoryStatus()
    const timer = window.setInterval(() => {
      loadActivityStatus()
      loadHistoryStatus()
    }, 5000)
    const offHistory = api.on('guzi-assistant:history-updated', loadHistoryStatus)
    return () => {
      window.clearInterval(timer)
      offHistory()
    }
  }, [])

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 2500)
  }

  const saveSettings = (patch: Partial<AppSettings>): Promise<boolean> => {
    setSettings((current) => current ? { ...current, ...patch } : current)
    const pending = settingsQueue.current.then(async () => {
      const ok = await api.saveSettings(patch)
      if (!ok) throw new Error('保存设置失败，请检查快捷键是否被占用')
      if (savedSettings.current) savedSettings.current = { ...savedSettings.current, ...patch }
      return true
    })
    const tracked = trackExitSave(pending, 'app-settings')
    settingsQueue.current = tracked.catch((error: unknown) => {
      flash(error instanceof Error ? error.message : String(error))
    })
    return tracked
  }

  const settingsPatch = (): Partial<AppSettings> => {
    const settings = settingsValue.current
    if (!settings || !savedSettings.current) return {}
    const next = { ...settings,
      taskReminderOffsetMin: Math.min(1440, Math.max(0, Number(settings.taskReminderOffsetMin) || 0)),
      assistantAutoCloseSec: Math.min(600, Math.max(0, Number(settings.assistantAutoCloseSec) || 0)),
      screenSenseRetentionDays: Math.min(365, Math.max(0, Number(settings.screenSenseRetentionDays) || 0)),
      mcpPort: Math.min(65535, Math.max(1024, Number(settings.mcpPort) || 38999)),
      voiceApiBase: settings.voiceApiBase.trim(), voiceApiKey: settings.voiceApiKey.trim(), voiceModel: settings.voiceModel.trim(),
      feishuAppId: settings.feishuAppId.trim(), feishuAppSecret: settings.feishuAppSecret.trim()
    }
    return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== savedSettings.current?.[key as keyof AppSettings])) as Partial<AppSettings>
  }

  useExitParticipant({
    id: 'app-settings',
    label: '飞书机器人配置',
    isDirty: () => {
      const current = settingsValue.current
      return !!current && !!savedSettings.current && (current.feishuAppId.trim() !== savedSettings.current.feishuAppId || current.feishuAppSecret.trim() !== savedSettings.current.feishuAppSecret)
    },
    alwaysPrepare: true,
    prepare: async (decision) => {
      await settingsQueue.current
      const patch = settingsPatch()
      if (decision === 'discard') {
        delete patch.feishuAppId
        delete patch.feishuAppSecret
      }
      if (Object.keys(patch).length) await saveSettings(patch)
    }
  })

  useExitParticipant({
    id: 'settings-profile',
    label: '确认模式设置',
    isDirty: () => false,
    alwaysPrepare: true,
    prepare: async () => {
      const next = profileValue.current
      if (next && JSON.stringify(next) !== JSON.stringify(savedProfile.current)) {
        await trackExitSave(api.saveProfile(next), 'settings-profile')
        savedProfile.current = next
        onProfileChange(next)
      }
    }
  })

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
        const ok = await saveSettings({ [key]: acc })
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
    profileValue.current = next
    setProfile(next)
    await trackExitSave(api.saveProfile(next), 'settings-profile')
    savedProfile.current = next
    onProfileChange(next)
  }

  const wipe = async (): Promise<void> => {
    if (!window.confirm('将删除全部用户内容：任务、来源、档案、活动与历史、日报、对话、语音纪要及录音、插件记录与成就、笔记及图片。应用设置、插件配置与启用状态会保留。此操作无法恢复，确定清除？')) return
    try {
      await api.wipeData()
    } catch {
      // 主进程原生错误框不会被清空后的窗口重载打断。
    }
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
    <div className="mx-auto flex max-w-6xl gap-6 px-8 py-8">
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
          <GeneralSection
            saveSettings={saveSettings}
            profile={profile}
            settings={settings}
            setSettings={setSettings}
            flash={flash}
            saveProfile={saveProfile}
          />
        )}
        {cat === '快捷键' && (
          <HotkeySection
            settings={settings}
            recordingKey={recordingKey}
            setRecordingKey={setRecordingKey}
          />
        )}
        {cat === '助手' && (
          <AssistantSection saveSettings={saveSettings} settings={settings} setSettings={setSettings} flash={flash} />
        )}
        {cat === '集成' && (
          <IntegrationSection
            saveSettings={saveSettings}
            settings={settings}
            setSettings={setSettings}
            qaInstalled={qaInstalled}
            setQaInstalled={setQaInstalled}
            feishu={feishu}
            setFeishu={setFeishu}
            flash={flash}
          />
        )}
        {cat === '屏幕感知' && (
          <ScreenSenseSection
            saveSettings={saveSettings}
            settings={settings}
            setSettings={setSettings}
            perms={perms}
            activityStatus={activityStatus}
            historyStatus={historyStatus}
            setHistoryStatus={setHistoryStatus}
            loadPerms={loadPerms}
            loadActivityStatus={loadActivityStatus}
            flash={flash}
          />
        )}
        {cat === '语音纪要' && (
          <VoiceNotesSection saveSettings={saveSettings} settings={settings} setSettings={setSettings} flash={flash} />
        )}
        {cat === '数据' && (
          <DataSection
            exportFrom={exportFrom}
            setExportFrom={setExportFrom}
            exportTo={exportTo}
            setExportTo={setExportTo}
            flash={flash}
            wipe={wipe}
            wipeMemory={wipeMemory}
          />
        )}
        {cat === '关于' && (
          <AboutSection
            appVersion={appVersion}
            checkingUpdate={checkingUpdate}
            setCheckingUpdate={setCheckingUpdate}
          />
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
