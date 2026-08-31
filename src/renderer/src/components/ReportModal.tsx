import { useEffect, useState } from 'react'
import type { ReportRecord } from '@shared/types'
import { contentSinksOf } from '@shared/plugin-manifest'
import { PLUGINS } from '@shared/plugin-registry'
import { api } from '../api'
import Modal from './Modal'
import Markdown from './Markdown'

interface Props {
  report: ReportRecord
  onExport: () => void
  onClose: () => void
}

type Sink = ReturnType<typeof contentSinksOf>[number]

/** 日报正文弹窗：居中大窗渲染 Markdown（日报页与分析页回看共用）。 */
export default function ReportModal({ report, onExport, onClose }: Props): React.JSX.Element {
  // 「保存到…」按已启用插件里声明的接收器列出：一个都没装时这里就是空的，
  // 弹窗只剩导出——核心不认识记事本，只认识这份契约。
  const [sinks, setSinks] = useState<Sink[]>([])
  const [note, setNote] = useState('')

  useEffect(() => {
    void api.listPlugins().then((states) => {
      const enabled = states.filter((s) => s.enabled).map((s) => s.manifest.id)
      setSinks(contentSinksOf(PLUGINS, enabled))
    })
  }, [])

  const saveTo = async (sink: Sink): Promise<void> => {
    const res = await api.plugin<{ ok: boolean; message: string }>(sink.pluginId, sink.action, {
      title: report.title,
      content: report.content,
      sourceRef: report.id
    })
    setNote(res?.message ?? '')
    window.setTimeout(() => setNote(''), 2500)
  }

  return (
    <Modal
      panelClass="flex max-h-[78vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl"
      onClose={onClose}
    >
      {(close) => (
        <>
          <header className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-6 py-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold">{report.title}</div>
              <div className="mt-0.5 text-xs text-slate-400">
                生成于 {report.createdAt.slice(0, 16).replace('T', ' ')}
              </div>
            </div>
            {note && <span className="shrink-0 text-xs text-emerald-600">{note}</span>}
            {sinks.map((s) => (
              <button
                key={`${s.pluginId}:${s.action}`}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                onClick={() => void saveTo(s)}
              >
                {s.label}
              </button>
            ))}
            <button
              className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              onClick={onExport}
            >
              导出
            </button>
            <button
              aria-label="关闭"
              className="shrink-0 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              onClick={close}
            >
              ✕
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <Markdown text={report.content} />
          </div>
        </>
      )}
    </Modal>
  )
}
