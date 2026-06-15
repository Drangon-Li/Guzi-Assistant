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
      panelClass="modal"
      onClose={onClose}
    >
      {(close) => (
        <>
          <div className="modal-head">
            <h3>来源证据</h3>
            <button className="x" onClick={close}>✕</button>
          </div>
          <div className="modal-body">
            {source === undefined && (
              <div className="py-8 text-center text-sm" style={{ color: 'var(--t3)' }}>加载中…</div>
            )}
            {source === null && (
              <div className="py-8 text-center text-sm" style={{ color: 'var(--t3)' }}>来源不存在</div>
            )}
            {source && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span className="tag">{SOURCE_LABELS[source.type]}</span>
                  <span className="time">提交于 {fmtTime(source.createdAt)}</span>
                  {source.filePath && (
                    <span className="time" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.filePath}</span>
                  )}
                </div>
                {shot && !source.deleted && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="subhead" style={{ margin: '0 0 6px' }}>截图（本地加密保存）</div>
                    <img src={shot} alt="截图缩略图" style={{ maxHeight: 192, borderRadius: 'var(--r-sm)', border: '1px solid var(--line-2)' }} />
                  </div>
                )}
                {source.deleted ? (
                  <div className="excerpt" style={{ WebkitLineClamp: 'unset', display: 'block', textAlign: 'center', color: 'var(--t3)' }}>
                    原文已删除
                  </div>
                ) : source.content?.startsWith('data:image') ? (
                  <img src={source.content} alt="来源截图" style={{ maxWidth: '100%', borderRadius: 'var(--r-sm)' }} />
                ) : (
                  <pre className="excerpt" style={{ WebkitLineClamp: 'unset', display: 'block', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                    {source.content ?? source.excerpt}
                  </pre>
                )}
              </>
            )}
          </div>
          {source && !source.deleted && (
            <div className="modal-foot">
              <button
                className="btn ghost sm"
                style={{ color: 'var(--danger)' }}
                onClick={handleDelete}
              >
                删除来源原文
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
