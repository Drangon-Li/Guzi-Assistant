import { useCallback, useEffect, useState } from 'react'
import type { MemoryRecord } from '@shared/types'
import { api } from '../api'

/**
 * 记忆页：整理归档（把零散捕获归纳成「记忆」+ 抽待办，借鉴 mem0 设计，全本地）+ 语义检索记忆。
 */
export default function Memory(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [memories, setMemories] = useState<MemoryRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [note, setNote] = useState('')
  const [searched, setSearched] = useState(false)

  const load = useCallback(async (q: string): Promise<void> => {
    setBusy(true)
    try {
      setMemories(await api.searchMemorySemantic(q))
      setSearched(!!q.trim())
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load('')
  }, [load])

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
      await load(query)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setConsolidating(false)
    }
  }

  return (
    <div className="page animate-page flex flex-col" style={{ gap: 14 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">记忆</h1>
          <p style={{ marginTop: 2, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6 }}>
            把零散捕获归纳成「记忆」并识别待办，按语义检索。全部本地，不上传。
          </p>
        </div>
        <button className="btn primary sm" disabled={consolidating} onClick={() => void consolidate()}>
          {consolidating ? '整理中…' : '整理归档'}
        </button>
      </div>

      {note && <div style={{ fontSize: 11.5, color: 'var(--t2)' }}>{note}</div>}

      <label className="field">
        <input
          placeholder="按语义搜索记忆，回车检索（留空看全部）…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(query)
          }}
        />
      </label>

      {busy && <div style={{ fontSize: 13, color: 'var(--t3)' }}>检索中…</div>}

      {!busy && memories.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>
          {searched ? '没有匹配的记忆。' : '还没有记忆。捕获一些内容后点「整理归档」。'}
        </div>
      )}

      {!busy && memories.length > 0 && (
        <ul className="stagger flex flex-col gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {memories.map((m) => (
            <li key={m.id}>
              <div
                className="card"
                style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--t1)' }}>{m.summary}</div>
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
    </div>
  )
}
