import { useEffect, useState } from 'react'
import type {
  AppSettings,
  FeishuStatus,
  PermissionStatus,
  Profile,
  ScreenActivityStatus
} from '@shared/types'
import type { HistoryStatus } from '@shared/history'
import { api } from '../api'
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
  const [settings, setSettings] = useState<AppSettings | null>(null)
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
    void api.getProfile().then(setProfile)
    void api.appVersion().then(setAppVersion)
    void api.getSettings().then(setSettings)
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
          <AssistantSection settings={settings} setSettings={setSettings} flash={flash} />
        )}
        {cat === '集成' && (
          <IntegrationSection
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
          <VoiceNotesSection settings={settings} setSettings={setSettings} flash={flash} />
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
