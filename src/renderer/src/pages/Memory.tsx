import { useState } from 'react'
import type { MemoryHit, SourceType } from '@shared/types'
import { api } from '../api'
import SourceModal from '../components/SourceModal'

const SOURCE_LABELS: Record<SourceType, string> = {
  clipboard_text: '剪贴板',
  clipboard_image: '剪贴板图',
  clipboard_file: '剪贴板文件',
  screenshot: '截图',
  file: '文件',
  text_input: '手动输入',
  feishu: '飞书',
  screen_scan: '屏幕'
}

/** #52 可搜索记忆底座：按关键词搜历史屏幕/剪贴板内容，定位回来源与其派生任务。 */
export default function Memory(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    setBusy(true)
    try {
      setHits(await api.searchMemory(q))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page animate-page flex flex-col" style={{ gap: 14 }}>
      <div>
        <h1 className="page-title">记忆</h1>
        <p style={{ marginTop: 2, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6 }}>
          搜索捕获过的历史内容（屏幕 / 剪贴板 / 文件），定位回来源。全部本地，不上传。
        </p>
      </div>

      <label className="field">
        <input
          autoFocus
          placeholder="搜关键词，回车检索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
        />
      </label>

      {busy && (
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>检索中…</div>
      )}

      {!busy && hits !== null && hits.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>没有匹配的历史内容。</div>
      )}

      {!busy && hits && hits.length > 0 && (
        <ul className="stagger flex flex-col gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {hits.map((h) => (
            <li key={h.source.id}>
              <button
                onClick={() => setSourceId(h.source.id)}
                className="row"
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 5 }}
              >
                <div className="flex items-center gap-2">
                  <span className="tag">{SOURCE_LABELS[h.source.type] ?? h.source.type}</span>
                  <span style={{ fontSize: 11, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>
                    {h.source.createdAt.slice(0, 16).replace('T', ' ')}
                  </span>
                  {h.taskCount > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--t3)' }}>· 派生 {h.taskCount} 条待办</span>
                  )}
                </div>
                <div
                  className="title"
                  style={{ whiteSpace: 'normal', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                >
                  {h.snippet || h.source.excerpt}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sourceId && <SourceModal sourceId={sourceId} onClose={() => setSourceId(null)} />}
    </div>
  )
}
