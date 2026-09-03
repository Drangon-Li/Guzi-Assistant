// 设置页「语音纪要」分区。状态由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings, PermissionStatus } from '@shared/types'
import type { VoiceSessionRecord } from '@shared/voicenotes'
import { api } from '../../api'
import { Section, Toggle } from '../ui'

interface Props {
  settings: AppSettings
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  flash: (msg: string) => void
}

const input =
  'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none'

export default function VoiceNotesSection({
  settings,
  setSettings,
  flash
}: Props): React.JSX.Element {
  const [session, setSession] = useState<VoiceSessionRecord | null>(null)
  const [recent, setRecent] = useState<VoiceSessionRecord[]>([])
  const [probing, setProbing] = useState(false)
  const [probeNote, setProbeNote] = useState('')
  const [perms, setPerms] = useState<PermissionStatus | null>(null)

  useEffect(() => {
    const load = (): void => {
      void api.voiceState().then(setSession)
      void api.voiceSessions().then((list) => setRecent(list.slice(0, 5)))
      void api.permissions().then(setPerms)
    }
    load()
    const offState = api.on('guzi-assistant:voice-state', load)
    const offUpdated = api.on('guzi-assistant:voice-updated', load)
    return () => {
      offState()
      offUpdated()
    }
  }, [])

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    setSettings({ ...settings, ...patch })
    await api.saveSettings(patch)
  }

  const configured = !!settings.voiceApiBase && !!settings.voiceApiKey

  return (
    <>
      <Section title="语音纪要">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          开会时把说的话记下来，会后自动转成文字，再从里面挑出该你做的事。默认关闭。
          只录麦克风，不录系统声音；转录时每段音频会发到你在下面配置的服务，
          录音本身默认不留在硬盘上。
        </p>

        <label className="flex items-center justify-between gap-4 text-sm">
          <span>语音纪要</span>
          <Toggle
            checked={settings.voiceNotesEnabled}
            ariaLabel="语音纪要"
            onChange={async (next) => {
              await save({ voiceNotesEnabled: next })
              flash(next ? '已开启语音纪要' : '已关闭语音纪要')
            }}
          />
        </label>

        {settings.voiceNotesEnabled && (
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                开会时自动开始
                <span className="ml-2 text-xs text-slate-400">
                  检测到 Zoom / 腾讯会议 / 飞书会议等在前台时自动录，散会后自动停
                </span>
              </span>
              <Toggle
                checked={settings.voiceAutoStart}
                ariaLabel="开会时自动开始"
                onChange={async (next) => {
                  await save({ voiceAutoStart: next })
                  flash(next ? '开会时会自动录制' : '改为只能手动开始')
                }}
              />
            </label>

            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                保留音频文件
                <span className="ml-2 text-xs text-slate-400">
                  默认不保留，转录完即删。开启后音频留在本机，可自行回听
                </span>
              </span>
              <Toggle
                checked={settings.voiceKeepAudio}
                ariaLabel="保留音频文件"
                onChange={async (next) => {
                  await save({ voiceKeepAudio: next })
                  flash(next ? '会保留音频文件' : '转录完即删除音频')
                }}
              />
            </label>

            <div className="border-t border-slate-100 pt-4">
              <div className="mb-2 text-sm">
                转录服务
                <span className="ml-2 text-xs text-slate-400">
                  OpenAI 兼容的 /v1/audio/transcriptions 端点
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-xs text-slate-500">
                  API 地址
                  <input
                    className={input}
                    value={settings.voiceApiBase}
                    placeholder="如：https://api.openai.com"
                    onChange={(e) => setSettings({ ...settings, voiceApiBase: e.target.value })}
                    onBlur={(e) => void save({ voiceApiBase: e.target.value.trim() })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-500">
                  API Key
                  <input
                    className={input}
                    type="password"
                    value={settings.voiceApiKey}
                    placeholder="sk-…"
                    onChange={(e) => setSettings({ ...settings, voiceApiKey: e.target.value })}
                    onBlur={(e) => void save({ voiceApiKey: e.target.value.trim() })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-500">
                  模型
                  <input
                    className={input}
                    value={settings.voiceModel}
                    placeholder="如：gpt-4o-mini-transcribe"
                    onChange={(e) => setSettings({ ...settings, voiceModel: e.target.value })}
                    onBlur={(e) => void save({ voiceModel: e.target.value.trim() })}
                  />
                </label>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  disabled={!configured || probing}
                  onClick={async () => {
                    setProbing(true)
                    setProbeNote('')
                    const r = await api.voiceProbe()
                    setProbeNote(r.message)
                    setProbing(false)
                  }}
                >
                  {probing ? '测试中…' : '测试连接'}
                </button>
                {probeNote && <span className="text-xs text-slate-500">{probeNote}</span>}
              </div>
              {!configured && (
                <p className="mt-2 text-xs text-amber-600">
                  还没配置转录服务，录下来的内容无法转成文字。
                </p>
              )}
              {perms && perms.microphone !== 'granted' && (
                <p className="mt-2 text-xs text-amber-600">
                  麦克风未授权（{perms.microphone}），录制会失败。请到 系统设置 → 隐私与安全性 → 麦克风 中允许 谷子助手。
                </p>
              )}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm">
                  {session
                    ? session.status === 'recording'
                      ? `正在录制${session.app ? `（${session.app}）` : ''}`
                      : '正在转录与解析…'
                    : '当前没有在录'}
                </span>
                {session ? (
                  <button
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                    onClick={() => void api.voiceStop()}
                  >
                    结束并整理
                  </button>
                ) : (
                  <button
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark"
                    onClick={() => void api.voiceStart()}
                  >
                    手动开始
                  </button>
                )}
              </div>
              {!!recent.length && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {recent.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 flex-1 truncate text-slate-500">
                        {s.startedAt.slice(5, 16).replace('T', ' ')}
                        {s.app ? ` · ${s.app}` : ''}
                        {s.transcript ? ` · ${s.transcript.length} 字` : ''}
                      </span>
                      <span className="shrink-0 text-slate-400">
                        {s.status === 'failed'
                          ? '失败'
                          : s.status === 'done'
                            ? `${s.taskCount} 条待确认`
                            : '进行中'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Section>
    </>
  )
}
