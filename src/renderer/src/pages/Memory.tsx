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

const input =
  'w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 focus:outline-none'

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
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8 pb-16">
      <div>
        <h1 className="text-lg font-semibold">记忆</h1>
        <p className="mt-0.5 text-xs text-slate-400">
          搜索捕获过的历史内容（屏幕 / 剪贴板 / 文件），定位回来源。全部本地，不上传。
        </p>
      </div>

      <input
        className={input}
        autoFocus
        placeholder="搜关键词，回车检索…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void run()
        }}
      />

      {busy && <div className="text-sm text-slate-400">检索中…</div>}

      {!busy && hits !== null && hits.length === 0 && (
        <div className="text-sm text-slate-400">没有匹配的历史内容。</div>
      )}

      {!busy && hits && hits.length > 0 && (
        <ul className="stagger flex flex-col gap-2">
          {hits.map((h) => (
            <li key={h.source.id}>
              <button
                onClick={() => setSourceId(h.source.id)}
                className="w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition-colors hover:border-slate-300"
              >
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">
                    {SOURCE_LABELS[h.source.type] ?? h.source.type}
                  </span>
                  <span>{h.source.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  {h.taskCount > 0 && <span>· 派生 {h.taskCount} 条待办</span>}
                </div>
                <div className="mt-1.5 line-clamp-2 text-sm leading-6 text-slate-700">
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
