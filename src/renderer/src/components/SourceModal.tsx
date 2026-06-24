import { useEffect, useState } from 'react'
import type { SourceRecord } from '@shared/types'
import { api } from '../api'
import Modal from './Modal'
import { fmtTime, SOURCE_LABELS } from '../labels'

interface Props {
  sourceId: string
  onClose: () => void
}

export default function SourceModal({ sourceId, onClose }: Props): React.JSX.Element {
  const [source, setSource] = useState<SourceRecord | null | undefined>(undefined)
  const [shot, setShot] = useState<string | null>(null)

  const load = (): void => {
    void api.getSource(sourceId).then(setSource)
    void api.readShot(sourceId).then(setShot) // #52/#53：解密的截图缩略图（无则 null）
  }
  useEffect(load, [sourceId])

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm('删除来源原文后无法恢复（已生成的任务会保留）。确定删除？')) return
    await api.deleteSource(sourceId)
    load()
  }

  return (
    <Modal
      panelClass="flex max-h-[80vh] w-[560px] flex-col rounded-xl bg-surface p-5 shadow-2xl"
      onClose={onClose}
    >
      {(close) => (
        <>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">来源证据</h3>
          <button className="text-slate-400 hover:text-slate-600" onClick={close}>
            ✕
          </button>
        </div>
        {source === undefined && <div className="py-8 text-center text-sm text-slate-400">加载中…</div>}
        {source === null && <div className="py-8 text-center text-sm text-slate-400">来源不存在</div>}
        {source && (
          <>
            <div className="mb-3 flex items-center gap-3 text-xs text-slate-500">
              <span className="rounded bg-slate-100 px-2 py-0.5">{SOURCE_LABELS[source.type]}</span>
              <span>提交于 {fmtTime(source.createdAt)}</span>
              {source.filePath && <span className="truncate">{source.filePath}</span>}
            </div>
            {shot && !source.deleted && (
              <div className="mb-3">
                <div className="mb-1 text-[11px] text-slate-400">截图（本地加密保存）</div>
                <img src={shot} alt="截图缩略图" className="max-h-48 rounded border border-slate-200" />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
              {source.deleted ? (
                <div className="py-6 text-center text-sm text-slate-400">原文已删除</div>
              ) : source.content?.startsWith('data:image') ? (
                <img src={source.content} alt="来源截图" className="max-w-full rounded" />
              ) : (
                <pre className="text-xs leading-5 whitespace-pre-wrap text-slate-700">
                  {source.content ?? source.excerpt}
                </pre>
              )}
            </div>
            {!source.deleted && (
              <div className="mt-3 flex justify-end">
                <button
                  className="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                  onClick={handleDelete}
                >
                  删除来源原文
                </button>
              </div>
            )}
          </>
        )}
        </>
      )}
    </Modal>
  )
}
