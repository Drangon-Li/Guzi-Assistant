import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { UpdateState } from '@shared/update-state'
import { api } from '../../api'
import FeedbackSection from '../FeedbackSection'
import { Section } from '../ui'

interface Props {
  appVersion: string
  checkingUpdate: boolean
  setCheckingUpdate: Dispatch<SetStateAction<boolean>>
}
const buttonClass = 'rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50'
const phaseLabels: Partial<Record<UpdateState['phase'], string>> = {
  checking: '正在检查更新…', latest: '当前已是最新版本', available: '发现新版本',
  downloading: '正在下载更新…', verifying: '正在验证更新包…', ready: '更新包已下载并验证，可以安装',
  preparing: '正在确认并保存内容…', installing: '正在启动安装并重启…', error: '更新未完成'
}

export default function AboutSection({ appVersion, checkingUpdate, setCheckingUpdate }: Props): React.JSX.Element {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const off = api.on('guzi-assistant:update-state', (value) => setUpdate(value as UpdateState))
    void api.updateState().then(setUpdate).catch((reason) => setError(String(reason)))
    return off
  }, [])

  async function perform(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const value = await action()
      if (value && typeof value === 'object' && 'phase' in value) setUpdate(value as UpdateState)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  const phase = update?.phase
  const progressing = phase === 'downloading' || phase === 'verifying'
  const committing = phase === 'preparing' || phase === 'installing'
  const checking = checkingUpdate || phase === 'checking'
  const percent = update?.progress === undefined ? undefined : Math.round(Math.max(0, Math.min(1, update.progress)) * 100)
  const canCheck = !!update && (update.mode === 'legacy' || ['idle', 'latest', 'error'].includes(update.phase))
  return (
    <>
      <Section title="版本">
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-slate-500">当前版本 {update?.currentVersion || appVersion || '…'}</span>
            {update?.channel === 'test' && <span className="text-xs text-amber-700">隔离测试渠道</span>}
            <button className={buttonClass} disabled={busy || !canCheck || checking}
              onClick={() => { void perform(async () => {
                setCheckingUpdate(true)
                try { return await api.checkUpdate() } finally { setCheckingUpdate(false) }
              }) }}>
              {checking ? '检查中…' : '检查更新'}
            </button>
            {phase === 'available' && <button className={buttonClass} disabled={busy}
              onClick={() => { void perform(api.downloadUpdate) }}>下载更新</button>}
            {phase === 'ready' && <button className={buttonClass} disabled={busy}
              onClick={() => { void perform(api.installUpdate) }}>安装并重启</button>}
            {(progressing || checking || phase === 'ready') && update?.mode === 'sparkle' &&
              <button className={buttonClass} disabled={committing}
                onClick={() => { void perform(api.cancelUpdate) }}>取消更新</button>}
          </div>
          {update?.mode !== 'legacy' && <>
            {phase && phaseLabels[phase] && <p role="status" className="text-slate-600">
              {phaseLabels[phase]}{update?.version && ['available', 'downloading', 'verifying', 'ready'].includes(phase) ? ` · ${update.version}` : ''}
            </p>}
            {progressing && <div className="space-y-1">
              <progress className="h-2 w-full accent-blue-600" max={100} value={percent} aria-label="更新下载进度" />
              {percent !== undefined && <p className="text-xs text-slate-500">{percent}%</p>}
            </div>}
            {update?.message && <p role={phase === 'error' ? 'alert' : 'status'} className={phase === 'error' ? 'text-red-600' : 'text-slate-500'}>{update.message}</p>}
            {update?.lastInstalledVersion && <p className="text-xs text-slate-500">已完成升级并启动版本 {update.lastInstalledVersion}</p>}
            {phase === 'ready' && <p className="text-xs text-slate-500">安装前会确认未保存内容。取消保存会保留应用，普通退出不会安装更新。</p>}
            {update?.notes && <p className="whitespace-pre-wrap text-xs text-slate-500">{update.notes}</p>}
          </>}
          {error && <p role="alert" className="text-red-600">{error}</p>}
        </div>
      </Section>
      <FeedbackSection />
    </>
  )
}
