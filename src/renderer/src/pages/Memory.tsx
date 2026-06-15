import { useCallback, useEffect, useState } from 'react'
import type { MemoryHit, MemoryRecord, SourceType } from '@shared/types'
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

/**
 * 记忆页：上半=整理归纳出的「记忆」（#路线图 3a，本地归档）+ 一键整理；下半=#52 关键词检索原始来源。
 */
export default function Memory(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [memories, setMemories] = useState<MemoryRecord[]>([])
  const [consolidating, setConsolidating] = useState(false)
  const [note, setNote] = useState('')

  const loadMemories = useCallback(async (): Promise<void> => {
    setMemories(await api.listMemories())
  }, [])

  useEffect(() => {
    void loadMemories()
  }, [loadMemories])

  const consolidate = async (): Promise<void> => {
    setConsolidating(true)
    setNote('')
    try {
      const r = await api.consolidateMemories()
      setNote(
        r.sourcesProcessed === 0
          ? '没有新的内容需要整理。'
          : `已整理 ${r.sourcesProcessed} 条来源 → ${r.memories} 条记忆、${r.todos} 条待办。`
      )
      await loadMemories()
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setConsolidating(false)
    }
  }

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
      <div className="page-head">
        <div>
          <h1 className="page-title">记忆</h1>
          <p style={{ marginTop: 2, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6 }}>
            把零散捕获整理归纳成「记忆」，并从中识别待办。全部本地，不上传。
          </p>
        </div>
        <button className="btn primary sm" disabled={consolidating} onClick={() => void consolidate()}>
          {consolidating ? '整理中…' : '整理归档'}
        </button>
      </div>

      {note && <div style={{ fontSize: 11.5, color: 'var(--t2)' }}>{note}</div>}

      {memories.length > 0 && (
        <ul className="stagger flex flex-col gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {memories.map((m) => (
            <li key={m.id}>
              <div
                className="card"
                style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t1)' }}>{m.title}</div>
                  {m.timeRange && <span className="time">{m.timeRange}</span>}
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--t2)' }}>{m.summary}</div>
                {(m.entities.length > 0 || m.todoCount > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {m.entities.slice(0, 6).map((e) => (
                      <span key={e} className="tag">
                        {e}
                      </span>
                    ))}
                    {m.todoCount > 0 && (
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>· {m.todoCount} 条待办</span>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <label className="field" style={{ marginTop: 4 }}>
        <span>检索原始来源</span>
        <input
          placeholder="搜关键词，回车检索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
        />
      </label>

      {busy && <div style={{ fontSize: 13, color: 'var(--t3)' }}>检索中…</div>}

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
