import { memo, useCallback, useEffect, useState } from 'react'
import type { DetectionRecord, TaskRecord, TaskStatus } from '@shared/types'
import { api } from '../api'
import { dayKey, fmtTime, PRIORITY_LABELS, STATUS_LABELS, todayKey, TYPE_LABELS } from '../labels'
import EditTaskModal from '../components/EditTaskModal'
import SourceModal from '../components/SourceModal'
import TaskDetailModal from '../components/TaskDetailModal'
import Timeline, { type TimelineMode } from './Timeline'
import QuickAddTask from '../components/QuickAddTask'
import { Segmented } from '../components/ui'
import ContextMenu, { type MenuEntry } from '../components/ContextMenu'
import TagManager from '../components/TagManager'
import { rankTaskSuggestions } from '@shared/task-suggest'

interface Props {
  tasks: TaskRecord[]
  hotkeyLabel: string
  onOpenAssistant: () => void
}

type Tab = 'suggest' | 'today' | 'next3' | 'week' | 'all'
type View = 'list' | 'timeline'

const ACTIVE_STATUSES: TaskStatus[] = ['not_started', 'scheduled', 'in_progress', 'overdue']
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 视图/筛选选择持久化：切页会卸载组件，重进时恢复上一次的选择。 */
function readPref<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return valid.includes(v as T) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等场景写不进就算了，不影响功能 */
  }
}

function timeOf(t: TaskRecord): string | null {
  return t.dueTime ?? t.startTime
}

function byTime(a: TaskRecord, b: TaskRecord): number {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (!ta && !tb) return 0
  if (!ta) return 1
  if (!tb) return -1
  return ta.localeCompare(tb)
}

function nowLocal(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function Schedule({ tasks, hotkeyLabel, onOpenAssistant }: Props): React.JSX.Element {
  const [view, setViewRaw] = useState<View>(() => readPref('schedule.view', ['list', 'timeline'], 'list'))
  const [tab, setTabRaw] = useState<Tab>(() =>
    readPref('schedule.tab', ['suggest', 'today', 'next3', 'week', 'all'], 'today')
  )
  const [tlMode, setTlModeRaw] = useState<TimelineMode>(() =>
    readPref('schedule.tlMode', ['day', 'week', 'month'], 'day')
  )
  const setView = (v: View): void => {
    setViewRaw(v)
    writePref('schedule.view', v)
  }
  const setTab = (v: Tab): void => {
    setTabRaw(v)
    writePref('schedule.tab', v)
  }
  const setTlMode = (v: TimelineMode): void => {
    setTlModeRaw(v)
    writePref('schedule.tlMode', v)
  }
  // 标签筛选：点选一个标签只看该类任务；跨 tab 生效，不持久化（是临时视角不是模式）
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  // 重点标签（星标）：谷子建议对含这些标签的任务加分；存设置，跨端生效
  const [starredTags, setStarredTags] = useState<string[]>([])
  // 隐藏标签：不出现在标签栏（任务上的标签不动）；手动建的标签还没任务在用也要能选
  const [hiddenTags, setHiddenTags] = useState<string[]>([])
  const [customTags, setCustomTags] = useState<string[]>([])
  const [tagManager, setTagManager] = useState(false)
  useEffect(() => {
    const load = (): void =>
      void api.getSettings().then((s) => {
        setStarredTags(s.starredTags)
        setHiddenTags(s.hiddenTags)
        setCustomTags(s.customTags)
      })
    load()
    return api.on('guzi-assistant:settings-updated', load)
  }, [])
  const toggleStar = (tag: string): void => {
    const next = starredTags.includes(tag) ? starredTags.filter((t) => t !== tag) : [...starredTags, tag]
    setStarredTags(next)
    void api.saveSettings({ starredTags: next })
  }
  const toggleHidden = (tag: string): void => {
    const next = hiddenTags.includes(tag) ? hiddenTags.filter((t) => t !== tag) : [...hiddenTags, tag]
    setHiddenTags(next)
    void api.saveSettings({ hiddenTags: next })
    if (tagFilter === tag && !hiddenTags.includes(tag)) setTagFilter(null)
  }
  // 多选批量：只作用于主列表分区（已完成/已过期/已忽略区不参与）
  const [multiMode, setMultiMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchTag, setBatchTag] = useState('')
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)
  const exitMulti = (): void => {
    setMultiMode(false)
    setSelected(new Set())
    setBatchTag('')
    setConfirmBatchDelete(false)
  }
  // 下面几个回调都用 useCallback 固定引用：TaskRow 是 memo 组件，
  // 每渲染新建一个箭头函数会让 memo 失效，等于白包。
  const toggleSelect = useCallback(
    (t: TaskRecord): void =>
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(t.id)) next.delete(t.id)
        else next.add(t.id)
        return next
      }),
    []
  )
  const openDetail = useCallback((t: TaskRecord): void => setDetail(t), [])
  const openEdit = useCallback((t: TaskRecord): void => setEditing(t), [])
  const showSource = useCallback((t: TaskRecord): void => {
    if (t.sourceId) setSourceId(t.sourceId)
  }, [])
  const byTag = (list: TaskRecord[]): TaskRecord[] =>
    tagFilter ? list.filter((t) => t.tags.includes(tagFilter)) : list
  const [editing, setEditing] = useState<TaskRecord | null>(null)
  const [detail, setDetail] = useState<TaskRecord | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const flash = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(''), 3500)
  }

  // 右键菜单：任务行 / 顶部标签两种目标；菜单内删除走两步确认
  const [menu, setMenu] = useState<
    | { kind: 'task'; taskId: string; x: number; y: number }
    | { kind: 'tag'; tag: string; x: number; y: number }
    | null
  >(null)
  const [menuConfirm, setMenuConfirm] = useState(false)
  const openTaskMenu = useCallback((t: TaskRecord, e: React.MouseEvent): void => {
    e.preventDefault()
    setMenuConfirm(false)
    setMenu({ kind: 'task', taskId: t.id, x: e.clientX, y: e.clientY })
  }, [])
  const openTagMenu =
    (tag: string) =>
    (e: React.MouseEvent): void => {
      e.preventDefault()
      setMenuConfirm(false)
      setMenu({ kind: 'tag', tag, x: e.clientX, y: e.clientY })
    }

  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).sort(byTime)
  const pending = tasks.filter((t) => t.status === 'pending')
  const done = tasks.filter((t) => t.status === 'done')
  const ignored = tasks.filter((t) => t.status === 'ignored')
  const overdue = active.filter((t) => t.status === 'overdue')
  const unscheduled = active.filter((t) => !timeOf(t) && t.status !== 'overdue')
  // 已过期：时间在今天之前、但既没完成也没进 overdue 的任务（典型是只有开始时间的「开过的会」，
  // 不会被 due_time 驱动的 overdue 扫描抓到）。单独归入折叠区，与已完成/已忽略并列，不再滞留「全部」。
  const today = todayKey()
  const expired = active.filter((t) => {
    if (t.status === 'overdue') return false
    const d = dayKey(timeOf(t))
    return d !== null && d < today
  })
  const expiredIds = new Set(expired.map((t) => t.id))
  // 标签栏只列「还要办的事」的标签：已完成/已忽略任务独有的标签沉进标签管理面板，不占筛选栏。
  // 正在筛选的那个例外——否则筛到最后一条任务办完，标签自己消失，用户会以为筛选坏了。
  const activeTagPool = [...active.flatMap((t) => t.tags), ...customTags]
  const allTags = [...new Set(activeTagPool)]
    .filter((t) => !hiddenTags.includes(t) || t === tagFilter)
    .sort((a, b) => Number(starredTags.includes(b)) - Number(starredTags.includes(a)))
  if (tagFilter && !allTags.includes(tagFilter)) allTags.unshift(tagFilter)

  const sections: { title: string; list: TaskRecord[]; empty?: string; hints?: Map<string, string> }[] = []
  if (tab === 'suggest') {
    // 谷子建议：时间紧迫度 + 优先级本地打分，分档给出「先办什么」；含已过期/未排期的候选
    const tiers = rankTaskSuggestions(tasks, nowLocal(), { starredTags })
    if (!tiers.length) sections.push({ title: '谷子建议', list: [], empty: '没有待办任务，休息一下吧' })
    for (const tier of tiers)
      sections.push({
        title: tier.title,
        list: tier.items.map((s) => s.task),
        hints: new Map(tier.items.map((s) => [s.task.id, s.reasons.slice(0, 2).join(' · ')]))
      })
  } else if (tab === 'today') {
    if (overdue.length) sections.push({ title: '已延期', list: overdue })
    sections.push({
      title: '今日',
      list: active.filter((t) => dayKey(timeOf(t)) === today && t.status !== 'overdue'),
      empty: '今天没有安排的任务'
    })
    if (unscheduled.length) sections.push({ title: '未排期', list: unscheduled })
  } else if (tab === 'week' || tab === 'next3') {
    if (overdue.length) sections.push({ title: '已延期', list: overdue })
    const days = tab === 'next3' ? 3 : 7
    const base = new Date()
    for (let i = 0; i < days; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
      const pad = (n: number): string => String(n).padStart(2, '0')
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const list = active.filter((t) => dayKey(timeOf(t)) === key && t.status !== 'overdue')
      if (!list.length && i > 0) continue
      const label =
        i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : `${WEEKDAY[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`
      sections.push({ title: label, list, empty: i === 0 ? '今天没有安排的任务' : undefined })
    }
    if (unscheduled.length) sections.push({ title: '未排期', list: unscheduled })
  } else {
    sections.push({
      title: '全部未完成',
      list: active.filter((t) => !expiredIds.has(t.id)),
      empty: '没有未完成的任务'
    })
  }

  function taskMenuEntries(t: TaskRecord | undefined): MenuEntry[] {
    if (!t) return []
    const isDone = t.status === 'done'
    const sid = t.sourceId
    const entries: MenuEntry[] = [
      {
        label: isDone ? '取消完成' : '标记完成',
        onClick: () =>
          void api.updateTask(t.id, {
            status: isDone ? (t.dueTime || t.startTime ? 'scheduled' : 'not_started') : 'done'
          })
      },
      { label: '编辑', onClick: () => setEditing(t) },
      { label: '查看详情', onClick: () => setDetail(t) }
    ]
    if (sid) entries.push({ label: '查看来源', onClick: () => setSourceId(sid) })
    if (t.startTime || t.dueTime)
      entries.push({ label: '加入日历（.ics）', onClick: () => void api.exportTaskIcs(t) })
    if (!isDone && timeOf(t))
      entries.push(
        { type: 'separator' },
        { type: 'header', label: '推迟' },
        { label: '到明天', onClick: () => postponeTask(t, '1') },
        { label: '到后天', onClick: () => postponeTask(t, '2') },
        { label: '到下周一', onClick: () => postponeTask(t, 'monday') }
      )
    if (allTags.length) {
      entries.push({ type: 'separator' }, { type: 'header', label: '标签（点选切换）' })
      for (const tag of allTags.slice(0, 8)) {
        const has = t.tags.includes(tag)
        entries.push({
          label: `#${tag}`,
          checked: has,
          keepOpen: true,
          onClick: () =>
            void api.updateTask(t.id, { tags: has ? t.tags.filter((x) => x !== tag) : [...t.tags, tag] })
        })
      }
    }
    entries.push({ type: 'separator' })
    if (t.status !== 'ignored')
      entries.push({ label: '忽略', onClick: () => void api.updateTask(t.id, { status: 'ignored' }) })
    entries.push(
      menuConfirm
        ? {
            label: '确认删除',
            danger: true,
            onClick: () => {
              void api.deleteTask(t.id)
              flash('任务已删除')
            }
          }
        : { label: '删除…', danger: true, keepOpen: true, onClick: () => setMenuConfirm(true) }
    )
    return entries
  }

  function tagMenuEntries(tag: string): MenuEntry[] {
    return [
      {
        label: starredTags.includes(tag) ? '取消重点标签' : '设为重点（谷子建议加分）',
        checked: starredTags.includes(tag),
        onClick: () => toggleStar(tag)
      },
      {
        label: tagFilter === tag ? '取消筛选' : '仅看此标签',
        onClick: () => setTagFilter(tagFilter === tag ? null : tag)
      },
      {
        label: hiddenTags.includes(tag) ? '在标签栏显示' : '从标签栏隐藏',
        checked: hiddenTags.includes(tag),
        onClick: () => toggleHidden(tag)
      },
      { type: 'separator' },
      { label: '标签管理…', onClick: () => setTagManager(true) },
      { type: 'separator' },
      menuConfirm
        ? {
            label: '确认移除',
            danger: true,
            onClick: () => {
              for (const t of tasks)
                if (t.tags.includes(tag)) void api.updateTask(t.id, { tags: t.tags.filter((x) => x !== tag) })
              if (starredTags.includes(tag)) {
                const next = starredTags.filter((x) => x !== tag)
                setStarredTags(next)
                void api.saveSettings({ starredTags: next })
              }
              if (tagFilter === tag) setTagFilter(null)
              flash(`已移除标签 #${tag}`)
            }
          }
        : { label: '从所有任务移除…', danger: true, keepOpen: true, onClick: () => setMenuConfirm(true) }
    ]
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">日程</h1>
          {/* 视图切换：列表（操作）/ 时间轴（浏览）。原独立「时间轴」页并入此处 */}
          <Segmented
            value={view}
            onChange={setView}
            options={[
              ['list', '列表'],
              ['timeline', '时间轴']
            ]}
          />
        </div>
        {/* 右侧筛选随视图切换：列表=时间范围，时间轴=分组粒度 */}
        {view === 'list' ? (
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              ['suggest', '谷子建议'],
              ['today', '今日'],
              ['next3', '近三天'],
              ['week', '本周'],
              ['all', '全部']
            ]}
          />
        ) : (
          <Segmented
            value={tlMode}
            onChange={setTlMode}
            options={[
              ['day', '天'],
              ['week', '周'],
              ['month', '月']
            ]}
          />
        )}
      </div>

      {/* 这一行无条件显示：标签全被隐藏时它是唯一能进标签管理、把标签放回来的入口 */}
      {view === 'list' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {allTags.length > 0 && (
            <>
              {/* 选中态用 slate-800/slate-50 而非固定 text-white：深色主题把整条 slate 色阶翻转了
                  （slate-800 在深色下是近白），配死的白字会变成白底白字。两端都用色阶就能自动反相。 */}
              <button
                className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                  tagFilter === null
                    ? 'bg-slate-800 text-slate-50'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                }`}
                onClick={() => setTagFilter(null)}
              >
                全部
              </button>
              {allTags.map((t) => (
                <button
                  key={t}
                  className={`group rounded-full px-2.5 py-0.5 text-[11px] ${
                    tagFilter === t ? 'bg-brand text-white' : 'bg-brand-soft text-brand hover:bg-brand-soft/70'
                  }`}
                  onClick={() => setTagFilter(tagFilter === t ? null : t)}
                  onContextMenu={openTagMenu(t)}
                >
                  #{t}
                  <span
                    title={starredTags.includes(t) ? '取消重点（谷子建议不再加分）' : '设为重点（谷子建议加分）'}
                    className={`ml-1 ${
                      starredTags.includes(t) ? 'text-amber-500' : 'opacity-0 group-hover:opacity-60'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleStar(t)
                    }}
                  >
                    ★
                  </span>
                </button>
              ))}
            </>
          )}
          <div className="flex-1" />
          <button
            className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200"
            onClick={() => setTagManager(true)}
          >
            标签管理
          </button>
          <button
            className={`rounded-full px-2.5 py-0.5 text-[11px] ${
              multiMode ? 'bg-slate-800 text-slate-50' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
            onClick={() => (multiMode ? exitMulti() : setMultiMode(true))}
          >
            {multiMode ? '退出多选' : '多选'}
          </button>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-6 pb-10">
        {pending.length > 0 && (
          <button
            onClick={onOpenAssistant}
            className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left transition-colors hover:bg-amber-100/70"
          >
            <span className="text-sm text-amber-800">
              助手发现了 <b>{pending.length}</b> 个待确认事项
            </span>
            <span className="shrink-0 text-xs font-medium text-amber-700">去确认 →</span>
          </button>
        )}

        <PendingDetections />

        {tasks.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
            <div className="text-base font-semibold text-slate-800">还没有任何日程</div>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              谷子助手会自动留意你的通知、消息和截图，从中帮你拎出该办的事，发现后在右下角的助手里提给你确认。
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              也可以手动添加：复制内容后按 <b>{hotkeyLabel}</b>，或点右下角的助手直接问我 / 把文件拖进窗口。
            </p>
            <button
              onClick={onOpenAssistant}
              className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm text-white hover:bg-brand-dark"
            >
              打开助手
            </button>
          </div>
        )}

        {tasks.length > 0 && view === 'timeline' && <Timeline tasks={tasks} mode={tlMode} />}

        {tasks.length > 0 &&
          view === 'list' &&
          sections.map((sec) => (
          <section key={sec.title}>
            <h2 className="mb-2 text-xs font-medium text-slate-400">{sec.title}</h2>
            <div className="flex flex-col gap-2">
              {byTag(sec.list).map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  hint={sec.hints?.get(t.id)}
                  selectMode={multiMode}
                  selected={selected.has(t.id)}
                  onToggleSelect={toggleSelect}
                  onContextMenu={openTaskMenu}
                  onOpen={openDetail}
                  onEdit={openEdit}
                  onShowSource={showSource}
                />
              ))}
              {!sec.list.length && sec.empty && (
                <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-slate-400">
                  {sec.empty}
                </div>
              )}
            </div>
          </section>
        ))}

        {view === 'list' && expired.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 select-none">
              已过期（{expired.length}）
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {byTag(expired).map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onContextMenu={openTaskMenu}
                  onOpen={openDetail}
                  onEdit={openEdit}
                  onShowSource={showSource}
                />
              ))}
            </div>
          </details>
        )}

        {view === 'list' && ignored.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 select-none">
              已忽略（{ignored.length}）
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              {ignored.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{t.title}</span>
                  {t.feedback === 'not_mine' && (
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">
                      不是我的
                    </span>
                  )}
                  <button
                    className="shrink-0 rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => void api.updateTask(t.id, { status: 'pending', feedback: null })}
                  >
                    恢复
                  </button>
                  <IgnoredDeleteButton id={t.id} />
                </div>
              ))}
            </div>
          </details>
        )}

        {view === 'list' && done.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 select-none">
              已完成（{done.length}）
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {byTag(done).map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onContextMenu={openTaskMenu}
                  onOpen={openDetail}
                  onEdit={openEdit}
                  onShowSource={showSource}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      {editing && (
        <EditTaskModal
          task={editing}
          heading="编辑任务"
          confirmLabel="保存"
          onDelete={() => {
            void api.deleteTask(editing.id)
            setEditing(null)
            flash('任务已删除')
          }}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            // 延期任务改到未来时间后恢复为已安排
            if (editing.status === 'overdue' && patch.dueTime && patch.dueTime > nowLocal()) {
              patch.status = 'scheduled'
            }
            void api.updateTask(editing.id, patch)
            setEditing(null)
          }}
        />
      )}
      {detail && (
        <TaskDetailModal
          task={detail}
          onClose={() => setDetail(null)}
          onShowSource={() => detail.sourceId && setSourceId(detail.sourceId)}
        />
      )}
      {sourceId && <SourceModal sourceId={sourceId} onClose={() => setSourceId(null)} />}
      {tagManager && (
        <TagManager
          tasks={tasks}
          starredTags={starredTags}
          hiddenTags={hiddenTags}
          customTags={customTags}
          onSettings={(patch) => {
            if (patch.starredTags) setStarredTags(patch.starredTags)
            if (patch.hiddenTags) setHiddenTags(patch.hiddenTags)
            if (patch.customTags) setCustomTags(patch.customTags)
            void api.saveSettings(patch)
          }}
          onClose={() => setTagManager(false)}
        />
      )}

      {multiMode && selected.size > 0 && (
        <div className="animate-toast fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-slate-200 bg-surface px-3 py-2 shadow-lg">
          <span className="text-xs text-slate-500">已选 {selected.size} 条</span>
          <button
            className="rounded-lg bg-brand px-2.5 py-1 text-xs text-white hover:bg-brand-dark"
            onClick={() => {
              void api.bulkTasks([...selected], 'done')
              flash(`已完成 ${selected.size} 条`)
              exitMulti()
            }}
          >
            完成
          </button>
          <button
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
            onClick={() => {
              void api.bulkTasks([...selected], 'ignored')
              flash(`已忽略 ${selected.size} 条`)
              exitMulti()
            }}
          >
            忽略
          </button>
          <button
            className={`rounded-lg px-2.5 py-1 text-xs ${
              confirmBatchDelete
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'text-red-400 hover:bg-red-50 hover:text-red-600'
            }`}
            onClick={() => {
              if (!confirmBatchDelete) {
                setConfirmBatchDelete(true)
                return
              }
              for (const id of selected) void api.deleteTask(id)
              flash(`已删除 ${selected.size} 条`)
              exitMulti()
            }}
          >
            {confirmBatchDelete ? '确认删除' : '删除'}
          </button>
          <span className="h-4 w-px bg-slate-200" />
          <input
            className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:border-slate-400 focus:outline-none"
            placeholder="打标签…"
            value={batchTag}
            onChange={(e) => setBatchTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key !== 'Enter') return
              const tag = batchTag.trim().replace(/^#/, '')
              if (!tag) return
              for (const id of selected) {
                const t = tasks.find((x) => x.id === id)
                if (t && !t.tags.includes(tag)) void api.updateTask(id, { tags: [...t.tags, tag] })
              }
              flash(`已为 ${selected.size} 条打上 #${tag}`)
              exitMulti()
            }}
          />
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={
            menu.kind === 'task'
              ? taskMenuEntries(tasks.find((t) => t.id === menu.taskId))
              : tagMenuEntries(menu.tag)
          }
          onClose={() => setMenu(null)}
        />
      )}

      {/* 悬浮加号：随手记（自然语言解析）/ 表单 两种方式手动建日程 */}
      <QuickAddTask onAdded={flash} />
      {note && (
        <div
          key={note}
          className="animate-toast fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm text-white shadow-lg"
        >
          {note}
        </div>
      )}
    </div>
  )
}

/** 快速推迟：保留原钟点、只挪日期；开始/截止各自平移。改到未来后 updateTask 会自动解除已延期。 */
function postponeTask(task: TaskRecord, target: string): void {
  const base = new Date()
  let offset = Number(target)
  if (target === 'monday') {
    const dow = base.getDay()
    offset = ((8 - dow) % 7) || 7
  }
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const shift = (iso: string | null): string | null => (iso ? `${day}T${iso.slice(11, 16) || '09:00'}` : null)
  const patch: Partial<TaskRecord> = {}
  if (task.dueTime) patch.dueTime = shift(task.dueTime)
  if (task.startTime) patch.startTime = shift(task.startTime)
  void api.updateTask(task.id, patch)
}

function IgnoredDeleteButton({ id }: { id: string }): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  return confirm ? (
    <button
      className="shrink-0 rounded bg-red-500 px-2 py-1 text-[11px] text-white hover:bg-red-600"
      onClick={() => void api.deleteTask(id)}
    >
      确认删除
    </button>
  ) : (
    <button
      className="shrink-0 rounded px-2 py-1 text-[11px] text-red-400 hover:bg-red-50 hover:text-red-600"
      onClick={() => setConfirm(true)}
    >
      删除
    </button>
  )
}

// 回调统一收 task 参数（而不是让父组件按行闭包），父组件才能用 useCallback 传同一个引用进来。
// 配合 App.tsx 里「内容没变就沿用旧对象」的重建策略，勾一条任务只会重渲染那一行。
const TaskRow = memo(function TaskRow({
  task,
  hint,
  selectMode,
  selected,
  onToggleSelect,
  onContextMenu,
  onOpen,
  onEdit,
  onShowSource
}: {
  task: TaskRecord
  /** 「谷子建议」里的推荐理由，如「今天截止 · 高优先级」 */
  hint?: string
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: (task: TaskRecord) => void
  onContextMenu?: (task: TaskRecord, e: React.MouseEvent) => void
  onOpen: (task: TaskRecord) => void
  onEdit: (task: TaskRecord) => void
  onShowSource: (task: TaskRecord) => void
}): React.JSX.Element {
  const isDone = task.status === 'done'
  const isOverdue = task.status === 'overdue'
  // 'done'=勾选完成（划线停留后向右淡出收拢）；'restore'=取消完成（勾选/划线立即消失，向左淡出收拢）
  const [leaving, setLeaving] = useState<null | 'done' | 'restore'>(null)

  const toggle = (): void => {
    if (leaving) return
    const next: TaskStatus = isDone
      ? task.dueTime || task.startTime
        ? 'scheduled'
        : 'not_started'
      : 'done'
    // 动画播完（该行已收拢到零高度）再真正改状态，列表刷新时下方任务不会跳动；
    // 完成/取消方向相反，示意「归档」和「退回」
    const kind = isDone ? 'restore' : 'done'
    setLeaving(kind)
    window.setTimeout(() => void api.updateTask(task.id, { status: next }), kind === 'done' ? 400 : 300)
  }
  const checked = leaving === 'done' ? true : leaving === 'restore' ? false : isDone
  const strike = leaving === 'restore' ? false : isDone || leaving === 'done'

  // 多选模式：整行变成选择目标，勾选框/标题点击都切换选中，操作按钮隐藏
  if (selectMode) {
    return (
      <div
        className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-surface px-4 py-3 shadow-sm ${
          selected ? 'border-brand ring-1 ring-brand/40' : 'border-slate-200'
        }`}
        onClick={() => onToggleSelect?.(task)}
      >
        <input type="checkbox" readOnly checked={!!selected} className="size-4 shrink-0 accent-brand" />
        <div className="min-w-0 flex-1">
          <div className={`truncate text-sm ${selected ? 'text-slate-900' : ''}`}>{task.title}</div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-400">
            {task.dueTime && <span>截止 {fmtTime(task.dueTime)}</span>}
            {!task.dueTime && task.startTime && <span>开始 {fmtTime(task.startTime)}</span>}
            {task.tags.map((t) => (
              <span key={t} className="rounded bg-brand-soft px-1 text-[10px] text-brand">
                #{t}
              </span>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-sm ${
        leaving === 'done' ? 'animate-task-done' : leaving === 'restore' ? 'animate-task-restore' : ''
      }`}
      onContextMenu={(e) => onContextMenu?.(task, e)}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={toggle}
        className="size-4 shrink-0 accent-brand"
      />
      <div className="min-w-0 flex-1">
        <button
          onClick={() => onOpen(task)}
          className={`block w-full truncate text-left text-sm hover:text-slate-900 ${
            strike ? 'text-slate-400 line-through' : ''
          }`}
        >
          {task.title}
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-400">
          {hint && (
            <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">
              {hint}
            </span>
          )}
          <span>{TYPE_LABELS[task.itemType]}</span>
          {task.notes.length > 0 && <span>{task.notes.length} 条注意事项</span>}
          {task.startTime && <span>开始 {fmtTime(task.startTime)}</span>}
          {task.dueTime && (
            <span className={isOverdue ? 'font-medium text-red-500' : ''}>
              截止 {fmtTime(task.dueTime)}
            </span>
          )}
          {task.location && <span>{task.location}</span>}
          {task.priority !== 'unknown' && <span>优先级 {PRIORITY_LABELS[task.priority]}</span>}
          {task.checklist.length > 0 && (
            <span>清单 {task.checklist.filter((c) => c.done).length}/{task.checklist.length}</span>
          )}
          {task.tags.map((t) => (
            <span key={t} className="rounded bg-brand-soft px-1 text-[10px] text-brand">
              #{t}
            </span>
          ))}
        </div>
      </div>
      {!isDone && timeOf(task) && (
        <select
          value=""
          onChange={(e) => {
            const v = e.target.value
            if (v) postponeTask(task, v)
            e.target.value = ''
          }}
          className="shrink-0 rounded-lg border border-slate-200 px-1.5 py-1 text-[11px] text-slate-500 focus:outline-none"
          title="快速推迟"
        >
          <option value="" disabled hidden>
            推迟
          </option>
          <option value="1">到明天</option>
          <option value="2">到后天</option>
          <option value="monday">到下周一</option>
        </select>
      )}
      {isOverdue ? (
        <span className="shrink-0 rounded-full border border-[#c0584e]/30 px-2 py-0.5 text-[11px] text-[#c0584e]">
          已延期
        </span>
      ) : (
        !isDone && (
          <select
            value={task.status}
            onChange={(e) => void api.updateTask(task.id, { status: e.target.value as TaskStatus })}
            className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 focus:outline-none"
          >
            {(['not_started', 'scheduled', 'in_progress'] as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        )
      )}
      <button
        className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-slate-700 hover:bg-slate-50"
        onClick={() => onEdit(task)}
      >
        编辑
      </button>
      {task.sourceId && (
        <button
          className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-slate-700 hover:bg-slate-50"
          onClick={() => onShowSource(task)}
        >
          来源
        </button>
      )}
    </div>
  )
})

/**
 * 待确认检测兜底区：没弹卡（完全被动模式）或弹卡未作决定的检测在这里回看处理。
 * （原「记忆 → 历史」的检测列表已随记忆页拆除，这里是唯一兜底入口。）
 */
function PendingDetections(): React.JSX.Element | null {
  const [dets, setDets] = useState<DetectionRecord[]>([])
  const [open, setOpen] = useState(false)
  const [multi, setMulti] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => void api.listDetections().then(setDets), [])
  useEffect(() => {
    load()
    // 检测无专属广播：蹭任务更新事件刷新（同意检测会触发它），展开时也会重新拉
    return api.on('guzi-assistant:tasks-updated', load)
  }, [load])

  // 主进程只回 status='new'：没过入队门槛的存成 archived，压根不到这里
  if (!dets.length) return null
  const shown = dets.slice(0, 10)
  const allShownSelected = shown.every((d) => selected.has(d.id))

  const exitMulti = (): void => {
    setMulti(false)
    setSelected(new Set())
  }
  const toggleSelect = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const accept = async (id: string): Promise<void> => {
    await api.acceptDetection(id)
    load()
  }
  const dismiss = async (id: string): Promise<void> => {
    await api.dismissDetection(id)
    load()
  }
  // 积压兜底：历史弱信号可能攒几百条，逐条忽略不现实
  const dismissAll = async (): Promise<void> => {
    await Promise.all(dets.map((d) => api.dismissDetection(d.id)))
    load()
  }
  // 批量同意串行：acceptDetection 内部要查重，并发会让同一件事的两种表述都漏过去
  const acceptSelected = async (): Promise<void> => {
    setBusy(true)
    try {
      for (const id of selected) await api.acceptDetection(id)
    } finally {
      setBusy(false)
      exitMulti()
      load()
    }
  }
  const dismissSelected = async (): Promise<void> => {
    setBusy(true)
    try {
      await Promise.all([...selected].map((id) => api.dismissDetection(id)))
    } finally {
      setBusy(false)
      exitMulti()
      load()
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface shadow-sm">
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => {
          if (!open) load()
          else exitMulti() // 收起时退出多选，免得下次展开还留着上次的勾选
          setOpen(!open)
        }}
      >
        <span className="text-sm text-slate-600">
          有 <b className="text-brand">{dets.length}</b> 条检测待确认
          <span className="ml-2 text-xs text-slate-400">检测到但还没确认的日程；已过时的会自动转入忽略</span>
        </span>
        <span className={`shrink-0 text-xs text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>
          ›
        </span>
      </button>
      {open && (
        <ul className="border-t border-slate-100 px-4 py-1">
          <li className="flex items-center justify-between gap-2 py-1.5">
            {multi ? (
              <>
                <div className="flex items-center gap-3">
                  <button className="text-[11px] text-slate-400 hover:text-slate-700" onClick={exitMulti}>
                    退出多选
                  </button>
                  <button
                    className="text-[11px] text-slate-500 hover:text-brand"
                    onClick={() =>
                      setSelected(allShownSelected ? new Set() : new Set(shown.map((d) => d.id)))
                    }
                  >
                    {allShownSelected ? '取消全选' : '全选'}
                  </button>
                  <span className="text-[11px] text-slate-400">已选 {selected.size}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-50 hover:text-red-500 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                    disabled={!selected.size || busy}
                    onClick={() => void dismissSelected()}
                  >
                    忽略选中
                  </button>
                  <button
                    className="rounded-lg bg-brand px-3 py-1 text-[11px] text-white hover:bg-brand-dark disabled:opacity-40 disabled:hover:bg-brand"
                    disabled={!selected.size || busy}
                    onClick={() => void acceptSelected()}
                  >
                    确认选中
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  className="text-[11px] text-slate-500 hover:text-brand"
                  onClick={() => setMulti(true)}
                >
                  多选
                </button>
                {dets.length > 3 && (
                  <button
                    className="text-[11px] text-slate-400 hover:text-red-500"
                    onClick={() => void dismissAll()}
                  >
                    全部忽略（{dets.length}）
                  </button>
                )}
              </>
            )}
          </li>
          {shown.map((d) => (
            <li
              key={d.id}
              className={`flex items-center gap-3 border-b border-slate-100 py-2 last:border-b-0 ${
                multi ? 'cursor-pointer' : ''
              }`}
              onClick={multi ? () => toggleSelect(d.id) : undefined}
            >
              {multi && (
                <input
                  type="checkbox"
                  readOnly
                  checked={selected.has(d.id)}
                  className="size-4 shrink-0 accent-brand"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{d.title}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {d.timeIso ? fmtTime(d.timeIso) : '未识别到时间'} · 检测于{' '}
                  {d.createdAt.slice(5, 16).replace('T', ' ')}
                </div>
              </div>
              {!multi && (
                <>
                  <button
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                    onClick={() => void dismiss(d.id)}
                  >
                    忽略
                  </button>
                  <button
                    className="shrink-0 rounded-lg bg-brand px-3 py-1 text-[11px] text-white hover:bg-brand-dark"
                    onClick={() => void accept(d.id)}
                  >
                    同意
                  </button>
                </>
              )}
            </li>
          ))}
          {dets.length > 10 && (
            <li className="py-2 text-center text-[11px] text-slate-400">
              还有 {dets.length - 10} 条，处理后自动显示
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
