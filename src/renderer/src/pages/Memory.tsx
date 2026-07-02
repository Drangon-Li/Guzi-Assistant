import { useCallback, useEffect, useState } from 'react'
import type { DetectionRecord, MemoryHit, SourceType, WorkRecord } from '@shared/types'
import { dayKey, groupWorkPeriods, periodLabel } from '@shared/work-report'
import { api } from '../api'
import { fmtTime } from '../labels'
import SourceModal from '../components/SourceModal'
import { DayNav, Segmented } from '../components/ui'

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

type Tab = 'activity' | 'personal' | 'history'

/**
 * 记忆页：① 活动——某时段用户在做什么（工作记录聚合）② 个人记忆——AI 归纳的长期画像，
 * 供助手越用越懂用户 ③ 历史——来源检索 + 屏幕识别历史。区别于日报（当日汇报）。
 */
export default function Memory(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('activity')

  const wipeMemory = async (): Promise<void> => {
    if (
      !window.confirm(
        '将清空活动记录、个人记忆、来源历史与屏幕识别历史，无法恢复。任务、日报与个人档案不受影响。确定清空？'
      )
    )
      return
    await api.wipeMemory()
    window.location.reload()
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8 pb-16">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">记忆</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            记录你某段时间在做什么，并归纳成长期画像，让助手越用越懂你。全部本地，不上传。
          </p>
        </div>
        <button
          onClick={() => void wipeMemory()}
          className="mt-0.5 shrink-0 rounded-lg px-2.5 py-1 text-xs text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          清空所有记忆
        </button>
      </div>

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          ['activity', '活动'],
          ['personal', '个人记忆'],
          ['history', '历史']
        ]}
      />

      {tab === 'activity' && <ActivityTab />}
      {tab === 'personal' && <PersonalTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  )
}

/** 活动：按天翻看，每天内按时段聚合展示「几点到几点在做什么」。 */
function ActivityTab(): React.JSX.Element {
  const [day, setDay] = useState(() => dayKey(new Date()))
  const [records, setRecords] = useState<WorkRecord[]>([])

  useEffect(() => {
    void api.listWorkRecords(day).then(setRecords)
  }, [day])

  const periods = groupWorkPeriods(records)

  return (
    <div className="flex flex-col gap-4">
      <DayNav day={day} onChange={setDay} />

      {periods.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">
          这一天还没有活动记录。开启「设置 → 屏幕感知 → 工作记录」后，会自动记下你在做什么。
        </p>
      ) : (
        <ol className="flex flex-col">
          {periods.map((p) => (
            <li key={p.start + p.summary} className="relative flex gap-4 pb-5 pl-2">
              <span className="w-24 shrink-0 pt-0.5 text-right font-mono text-xs text-slate-400">
                {periodLabel(p)}
              </span>
              <div className="relative flex-1 border-l border-slate-200 pl-4">
                <span className="absolute top-1.5 -left-[5px] size-2.5 rounded-full border-2 border-slate-300 bg-surface" />
                <div className="text-sm leading-6">{p.summary}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-400">
                  {p.app && <span>{p.app}</span>}
                  {p.activities.length > 1 && <span>· {p.activities.length} 项活动</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** 个人记忆：基本画像（长期身份定义，手动维护）+ 近期行为画像（AI 归纳，可刷新）。 */
function PersonalTab(): React.JSX.Element {
  const [base, setBase] = useState('')
  const [recent, setRecent] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [dirtyBase, setDirtyBase] = useState(false)
  const [dirtyRecent, setDirtyRecent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyBase, setBusyBase] = useState(false)
  const [note, setNote] = useState('')

  const flash = (m: string): void => {
    setNote(m)
    window.setTimeout(() => setNote(''), 3000)
  }

  useEffect(() => {
    void api.getPersonalMemory().then((m) => {
      setBase(m.base)
      setRecent(m.recent)
      setUpdatedAt(m.updatedAt)
    })
  }, [])

  const save = async (part: 'base' | 'recent'): Promise<void> => {
    const m = await api.setPersonalMemory(part, part === 'base' ? base : recent)
    setUpdatedAt(m.updatedAt)
    if (part === 'base') setDirtyBase(false)
    else setDirtyRecent(false)
    flash('已保存')
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      const m = await api.refreshPersonalMemory('recent')
      setRecent(m.recent)
      setUpdatedAt(m.updatedAt)
      setDirtyRecent(false)
      flash('近期画像已更新')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const refreshBase = async (): Promise<void> => {
    setBusyBase(true)
    try {
      const m = await api.refreshPersonalMemory('base')
      setBase(m.base)
      setUpdatedAt(m.updatedAt)
      setDirtyBase(false)
      flash('基本画像已更新')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyBase(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">基本画像</h3>
            <p className="text-xs text-slate-400">
              你是谁：身份、方向、长期项目与偏好。长期维护，只存本地；AI 总结会在你写的基础上小幅演进。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              onClick={() => void refreshBase()}
              disabled={busyBase}
            >
              {busyBase ? '正在总结…' : 'AI 总结'}
            </button>
            <button
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              onClick={() => void save('base')}
              disabled={!dirtyBase}
            >
              保存
            </button>
          </div>
        </div>
        <textarea
          className={`${input} min-h-[120px] resize-y font-mono leading-6`}
          placeholder="例如：博士生，研究方向蛋白质设计；同时开发纸壳助手；常用 VS Code / Notion…"
          value={base}
          onChange={(e) => {
            setBase(e.target.value)
            setDirtyBase(true)
          }}
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">近期行为画像</h3>
            <p className="text-xs text-slate-400">最近在推进什么：AI 从近期活动与任务自动归纳，可手动修正。</p>
          </div>
          <button
            className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-50"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? '正在归纳…' : '立即更新'}
          </button>
        </div>
        <textarea
          className={`${input} min-h-[180px] resize-y font-mono leading-6`}
          placeholder="还没有近期画像。点「立即更新」让 AI 从你的活动里归纳。"
          value={recent}
          onChange={(e) => {
            setRecent(e.target.value)
            setDirtyRecent(true)
          }}
        />
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>{updatedAt ? `上次更新：${updatedAt.replace('T', ' ')}` : '尚未生成'}</span>
          <button
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            onClick={() => void save('recent')}
            disabled={!dirtyRecent}
          >
            保存修改
          </button>
        </div>
      </section>

      {note && <div className="text-xs text-emerald-600">{note}</div>}
    </div>
  )
}

/** 历史：来源检索 + 屏幕识别历史（原记忆页内容）。 */
function HistoryTab(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [dets, setDets] = useState<DetectionRecord[]>([])

  const loadDets = useCallback((): void => void api.listDetections().then(setDets), [])
  useEffect(() => loadDets(), [loadDets])

  const accept = async (id: string): Promise<void> => {
    await api.acceptDetection(id)
    loadDets()
  }
  const dismiss = async (id: string): Promise<void> => {
    await api.dismissDetection(id)
    loadDets()
  }
  const freshCount = dets.filter((d) => d.status === 'new').length

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
    <div className="flex flex-col gap-5">
      <input
        className={input}
        placeholder="搜关键词，回车检索捕获过的历史内容…"
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
                      className="shrink-0 rounded-lg bg-brand px-3 py-1 text-[11px] text-white hover:bg-brand-dark"
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
