import { useEffect, useState } from 'react'
import type { DetectionRecord, MemoryHit, SourceType } from '@shared/types'
import { api } from '../api'
import { fmtTime } from '../labels'
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
  const [dets, setDets] = useState<DetectionRecord[]>([])

  const loadDets = (): void => void api.listDetections().then(setDets)
  useEffect(loadDets, [])

  const accept = async (id: string): Promise<void> => {
    await api.acceptDetection(id)
    loadDets()
  }
  const dismiss = async (id: string): Promise<void> => {
    await api.dismissDetection(id)
    loadDets()
  }
  const freshCount = dets.filter((d) => d.status === 'new').length

  const wipeMemory = async (): Promise<void> => {
    if (!window.confirm('将清空所有屏幕识别历史与来源记忆，无法恢复。任务与个人档案不受影响。确定清空？'))
      return
    await api.wipeMemory()
    setHits(null)
    setQuery('')
    setDets([])
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
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8 pb-16">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">记忆</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            搜索捕获过的历史内容（屏幕 / 剪贴板 / 文件），定位回来源。全部本地，不上传。
          </p>
        </div>
        <button
          onClick={() => void wipeMemory()}
          className="mt-0.5 shrink-0 rounded-lg px-2.5 py-1 text-xs text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          清空所有记忆
        </button>
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
                className="w-full rounded-lg border border-slate-200 bg-surface px-4 py-3 text-left transition-colors hover:border-slate-300"
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

      {dets.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-medium text-slate-400">
            屏幕识别历史{freshCount > 0 && ` · ${freshCount} 条待处理`}
          </h2>
          <div className="stagger flex flex-col gap-2">
            {dets.slice(0, 12).map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-sm ${d.status !== 'new' ? 'text-slate-400' : ''}`}>
                    {d.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-400">
                    {d.timeIso ? (
                      <span>{fmtTime(d.timeIso)}</span>
                    ) : (
                      d.hits.length > 0 && <span>命中 {d.hits.join('、')}</span>
                    )}
                    <span>{d.createdAt.slice(5, 16).replace('T', ' ')}</span>
                  </div>
                </div>
                {d.status === 'new' ? (
                  <>
                    <button
                      onClick={() => void dismiss(d.id)}
                      className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                    >
                      忽略
                    </button>
                    <button
                      onClick={() => void accept(d.id)}
                      className="shrink-0 rounded-lg bg-ink px-3 py-1 text-[11px] text-white hover:bg-black"
                    >
                      同意
                    </button>
                  </>
                ) : (
                  <span
                    className={`shrink-0 text-[11px] ${
                      d.status === 'accepted' ? 'text-emerald-600' : 'text-slate-400'
                    }`}
                  >
                    {d.status === 'accepted' ? '✓ 已加入' : '已忽略'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {sourceId && <SourceModal sourceId={sourceId} onClose={() => setSourceId(null)} />}
    </div>
  )
}
