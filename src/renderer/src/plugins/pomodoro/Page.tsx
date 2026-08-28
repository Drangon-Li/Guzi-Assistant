// 专注页：番茄钟 + 今日目标 + 会话管理 + 按任务统计。
//
// 计时按 wall clock 算（记下 startAt 与累计暂停毫秒，每半秒重算剩余），不做倒数累减——
// 窗口切后台会被节流，累减的计时器越走越慢，wall clock 不会。暂停也不停秒表，
// 只记「从哪一刻起停的」，所以合上盖子再打开读数依然是对的。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRecord } from '@shared/types'
import { isFinishedEvent } from '@shared/task-filters'
import {
  DEFAULT_PREFS,
  focusLabel,
  formatCountdown,
  nextPhase,
  remainingSeconds,
  type DayStats,
  type PomodoroKind,
  type PomodoroPrefs,
  type PomodoroSession,
  type TaskBreakdown
} from '@shared/pomodoro'
import { minutesToLabel, type TimeBlock } from '@shared/timeblock'
import { dayKey } from '@shared/work-report'
import { api } from '../../api'
import { Section } from '../../components/ui'
import type { PluginPageProps } from '../types'

interface TodayPayload {
  today: string
  sessions: PomodoroSession[]
  stats: DayStats
  byTask: TaskBreakdown[]
}

type HistoryRow = { date: string; rounds: number; focusMinutes: number; hitGoal: boolean }

const ACTIVE_STATUS = new Set(['not_started', 'scheduled', 'in_progress', 'overdue'])

export default function PomodoroPage({ enabledPlugins }: PluginPageProps): React.JSX.Element {
  const timeblockEnabled = enabledPlugins.includes('timeblock')

  const [prefs, setPrefs] = useState<PomodoroPrefs>(DEFAULT_PREFS)
  const [session, setSession] = useState<PomodoroSession | null>(null)
  const [stats, setStats] = useState<DayStats>({
    rounds: 0,
    focusMinutes: 0,
    abandoned: 0,
    remainingToGoal: DEFAULT_PREFS.dailyGoal,
    goalProgress: 0
  })
  const [sessions, setSessions] = useState<PomodoroSession[]>([])
  const [byTask, setByTask] = useState<TaskBreakdown[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [remaining, setRemaining] = useState(0)
  const [queued, setQueued] = useState<{ kind: PomodoroKind; minutes: number; long: boolean } | null>(null)
  const [blocks, setBlocks] = useState<TimeBlock[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [pickedTask, setPickedTask] = useState<string>('')
  const [pickedBlock, setPickedBlock] = useState<string>('')
  const [customMin, setCustomMin] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const finishing = useRef(false)

  const refresh = useCallback(async () => {
    const [today, hist] = await Promise.all([
      api.plugin<TodayPayload>('pomodoro', 'today'),
      api.plugin<HistoryRow[]>('pomodoro', 'history', 14)
    ])
    setStats(today.stats)
    setSessions(today.sessions)
    setByTask(today.byTask)
    setHistory(hist)
  }, [])

  useEffect(() => {
    void api.plugin<PomodoroPrefs>('pomodoro', 'prefs').then(setPrefs)
    void api.plugin<PomodoroSession | null>('pomodoro', 'running').then((s) => setSession(s))
    void api.listTasks().then(setTasks)
    void refresh()
  }, [refresh])

  // 装了「作息」才去取时间块。没装就没有这个下拉，也不会有多余的一次 IPC。
  useEffect(() => {
    if (!timeblockEnabled) return
    void api
      .plugin<{ blocks: TimeBlock[] }>('timeblock', 'day', dayKey(new Date()))
      .then((r) => setBlocks(r.blocks))
  }, [timeblockEnabled])

  const finish = useCallback(
    async (completed: boolean) => {
      if (!session || finishing.current) return
      finishing.current = true
      const justFinished = session.kind
      await api.plugin('pomodoro', 'finish', session.id, completed)
      setSession(null)
      const after = await api.plugin<TodayPayload>('pomodoro', 'today')
      setStats(after.stats)
      setSessions(after.sessions)
      setByTask(after.byTask)
      void api.plugin<HistoryRow[]>('pomodoro', 'history', 14).then(setHistory)
      if (completed) {
        const next = nextPhase(justFinished, after.stats.rounds, prefs)
        setQueued(next)
        await api.plugin(
          'pomodoro',
          'say',
          justFinished === 'focus'
            ? `一轮专注完成了，歇 ${next.minutes} 分钟吧`
            : '休息结束，接着来一轮？'
        )
      } else {
        setQueued(null)
      }
      finishing.current = false
    },
    [session, prefs]
  )

  useEffect(() => {
    if (!session) return
    const tick = (): void => {
      const left = remainingSeconds(session, Date.now())
      setRemaining(left)
      if (left <= 0 && !session.pausedAt) void finish(true)
    }
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [session, finish])

  const activeTasks = useMemo(
    () => tasks.filter((t) => ACTIVE_STATUS.has(t.status) && !isFinishedEvent(t, new Date())),
    [tasks]
  )

  const start = useCallback(
    async (kind: PomodoroKind, minutes: number): Promise<void> => {
      const task = activeTasks.find((t) => t.id === pickedTask)
      const created = await api.plugin<PomodoroSession | null>(
        'pomodoro',
        'start',
        kind,
        minutes,
        kind === 'focus' ? pickedBlock || null : null,
        kind === 'focus' ? task?.id ?? null : null,
        kind === 'focus' ? task?.title ?? null : null
      )
      setQueued(null)
      setCustomMin(null)
      setSession(created)
    },
    [activeTasks, pickedTask, pickedBlock]
  )

  // 自动开始下一轮：勾了才自动，否则停在「准备开始」等用户点
  useEffect(() => {
    if (!queued || !prefs.autoStart || session) return
    void start(queued.kind, queued.minutes)
  }, [queued, prefs.autoStart, session, start])

  const togglePause = async (): Promise<void> => {
    if (!session) return
    setSession(
      await api.plugin<PomodoroSession | null>(
        'pomodoro',
        session.pausedAt ? 'resume' : 'pause',
        session.id
      )
    )
  }

  const saveNote = async (id: string, text: string): Promise<void> => {
    await api.plugin('pomodoro', 'note', id, text)
    await refresh()
  }

  const removeSession = async (id: string): Promise<void> => {
    if (!window.confirm('删除这一轮记录？统计会跟着变。')) return
    await api.plugin('pomodoro', 'delete', id)
    await refresh()
  }

  const paused = !!session?.pausedAt
  const total = session ? session.minutes * 60 : 0
  const ratio = total ? 1 - remaining / total : 0
  const maxRounds = useMemo(() => Math.max(1, ...history.map((h) => h.rounds)), [history])
  const startMinutes = customMin ?? prefs.focusMin

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">专注</h1>
        <p className="mt-0.5 text-xs text-slate-400">
          一轮专注加一轮休息。可以随时暂停，中途放弃也照样记下来——记录是为了看清自己，不是为了打分。
        </p>
      </header>

      {/* ---- 计时器 ---- */}
      <div className="mb-5 flex flex-col items-center rounded-xl border border-slate-200 bg-surface px-6 py-8 shadow-sm">
        <Dial ratio={ratio} kind={session?.kind ?? queued?.kind ?? 'focus'} dim={paused}>
          <div className={`text-4xl font-semibold tabular-nums ${paused ? 'text-slate-300' : ''}`}>
            {session ? formatCountdown(remaining) : formatCountdown(startMinutes * 60)}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {session
              ? paused
                ? '已暂停'
                : session.kind === 'focus'
                  ? '专注中'
                  : '休息中'
              : queued
                ? queued.kind === 'break'
                  ? queued.long
                    ? '该长休息了'
                    : '该休息了'
                  : '准备下一轮'
                : '准备开始'}
          </div>
          {session?.taskTitle && (
            <div className="mt-1 max-w-[9rem] truncate text-[11px] text-brand" title={session.taskTitle}>
              {session.taskTitle}
            </div>
          )}
        </Dial>

        {/* 开始前：选任务 / 时间块 / 时长 */}
        {!session && (
          <div className="mt-5 flex w-full max-w-md flex-col gap-2.5">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-14 shrink-0">关联任务</span>
              <select
                value={pickedTask}
                onChange={(e) => setPickedTask(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm text-slate-600 outline-none focus:border-brand"
              >
                <option value="">不关联</option>
                {activeTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>

            {timeblockEnabled && blocks.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span className="w-14 shrink-0">时间块</span>
                <select
                  value={pickedBlock}
                  onChange={(e) => setPickedBlock(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm text-slate-600 outline-none focus:border-brand"
                >
                  <option value="">不关联</option>
                  {blocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {minutesToLabel(b.startMin)} {b.title}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-14 shrink-0">时长</span>
              <div className="flex gap-1.5">
                {[prefs.focusMin, 15, 45, 60].filter((v, i, a) => a.indexOf(v) === i).map((m) => (
                  <button
                    key={m}
                    onClick={() => setCustomMin(m)}
                    className={`rounded-md border px-2.5 py-1 transition-colors ${
                      startMinutes === m
                        ? 'border-brand bg-brand-soft text-brand'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {m} 分
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex gap-3">
          {session ? (
            <>
              <button
                onClick={() => void togglePause()}
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-600 hover:border-brand hover:text-brand"
              >
                {paused ? '继续' : '暂停'}
              </button>
              <button
                onClick={() => void finish(session.kind === 'break')}
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-500 hover:border-slate-300"
              >
                {session.kind === 'break' ? '跳过休息' : '放弃这一轮'}
              </button>
            </>
          ) : queued ? (
            <>
              <button
                onClick={() => void start(queued.kind, queued.minutes)}
                className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white"
              >
                开始{queued.kind === 'break' ? `休息 ${queued.minutes} 分钟` : '下一轮'}
              </button>
              {queued.kind === 'break' && (
                <button
                  onClick={() => void start('focus', prefs.focusMin)}
                  className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-500"
                >
                  跳过休息，直接专注
                </button>
              )}
              <button
                onClick={() => setQueued(null)}
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-500"
              >
                先停一下
              </button>
            </>
          ) : (
            <button
              onClick={() => void start('focus', startMinutes)}
              className="rounded-lg bg-brand px-6 py-2 text-sm font-medium text-white"
            >
              开始专注 {startMinutes} 分钟
            </button>
          )}
        </div>
      </div>

      {/* ---- 今日目标 + 统计 ---- */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-[auto_1fr]">
        <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-surface px-5 py-4 shadow-sm">
          <GoalRing progress={stats.goalProgress} />
          <div>
            <div className="text-xs text-slate-400">今日目标</div>
            <div className="text-lg font-semibold tabular-nums">
              {stats.rounds} / {prefs.dailyGoal} 轮
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              {stats.remainingToGoal === 0 ? '今天达标了' : `还差 ${stats.remainingToGoal} 轮`}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="专注时长" value={focusLabel(stats.focusMinutes)} />
          <Stat label="完成轮数" value={`${stats.rounds} 轮`} />
          <Stat label="中途放弃" value={`${stats.abandoned} 轮`} muted />
        </div>
      </div>

      {/* ---- 今日会话管理 ---- */}
      <Section title="今天的专注" desc="点一条可以补记「这一轮做了什么」">
        {sessions.length === 0 ? (
          <p className="text-xs text-slate-400">今天还没有专注记录。</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onNote={(text) => void saveNote(s.id, text)}
                onDelete={() => void removeSession(s.id)}
              />
            ))}
          </ul>
        )}
      </Section>

      {/* ---- 按任务聚合 ---- */}
      {byTask.length > 0 && (
        <div className="mt-4">
          <Section title="时间去哪了" desc="今天完成的专注按关联任务归集">
            <ul className="space-y-2">
              {byTask.map((row) => {
                const max = byTask[0].minutes || 1
                return (
                  <li key={row.key} className="flex items-center gap-3 text-sm">
                    <span className="w-40 shrink-0 truncate" title={row.label}>
                      {row.label}
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full bg-brand/60"
                        style={{ width: `${Math.round((row.minutes / max) * 100)}%` }}
                      />
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs text-slate-400 tabular-nums">
                      {focusLabel(row.minutes)} · {row.rounds} 轮
                    </span>
                  </li>
                )
              })}
            </ul>
          </Section>
        </div>
      )}

      {/* ---- 两周趋势 ---- */}
      <div className="mt-4">
        <Section title="最近两周" desc="每天完成的专注轮数，达标的那天是实心的">
          <div className="flex h-24 items-end gap-1.5">
            {history.map((h) => (
              <div key={h.date} className="flex flex-1 flex-col items-center gap-1">
                <div
                  title={`${h.date}：${h.rounds} 轮 · ${focusLabel(h.focusMinutes)}`}
                  className={`w-full rounded-t ${
                    h.rounds === 0 ? 'bg-slate-100' : h.hitGoal ? 'bg-brand' : 'bg-brand/40'
                  }`}
                  style={{ height: `${Math.max(3, (h.rounds / maxRounds) * 100)}%` }}
                />
                <span className="text-[10px] text-slate-300 tabular-nums">{h.date.slice(8)}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}

/** 一条会话：时长、任务、备注（点开可编辑）、删除。 */
function SessionRow({
  session,
  onNote,
  onDelete
}: {
  session: PomodoroSession
  onNote: (text: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(session.note ?? '')

  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        className={`mt-1 size-2 shrink-0 rounded-full ${session.completed ? 'bg-brand' : 'bg-slate-300'}`}
        title={session.completed ? '完成' : '中途放弃'}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-sm">
          <span className="tabular-nums text-slate-500">{session.startAt.slice(11, 16)}</span>
          <span className="font-medium">{session.minutes} 分钟</span>
          {session.taskTitle && (
            <span className="truncate text-xs text-brand" title={session.taskTitle}>
              {session.taskTitle}
            </span>
          )}
          {!session.completed && <span className="text-xs text-slate-400">未完成</span>}
        </div>
        {editing ? (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              setEditing(false)
              if (text !== (session.note ?? '')) onNote(text)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setText(session.note ?? '')
                setEditing(false)
              }
            }}
            placeholder="这一轮做了什么"
            className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-brand"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="mt-0.5 block max-w-full truncate text-left text-xs text-slate-400 hover:text-slate-600"
          >
            {session.note || '＋ 记一句做了什么'}
          </button>
        )}
      </div>
      <button
        onClick={onDelete}
        className="shrink-0 text-xs text-slate-300 hover:text-red-500"
        title="删除这条记录"
      >
        删除
      </button>
    </li>
  )
}

function Stat({
  label,
  value,
  muted = false
}: {
  label: string
  value: string
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface px-4 py-3 shadow-sm">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${muted ? 'text-slate-400' : ''}`}>
        {value}
      </div>
    </div>
  )
}

/** 今日目标环。 */
function GoalRing({ progress }: { progress: number }): React.JSX.Element {
  const R = 26
  const C = 2 * Math.PI * R
  return (
    <svg viewBox="0 0 64 64" className="size-14 -rotate-90 shrink-0">
      <circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" strokeWidth="6" className="text-slate-100" />
      <circle
        cx="32"
        cy="32"
        r={R}
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - Math.max(0, Math.min(1, progress)))}
        className="text-brand"
      />
    </svg>
  )
}

/** 环形进度：一圈就是这一轮，走完即满。暂停时整体变浅，一眼看出没在走。 */
function Dial({
  ratio,
  kind,
  dim,
  children
}: {
  ratio: number
  kind: PomodoroKind
  dim: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const R = 82
  const C = 2 * Math.PI * R
  return (
    <div className="relative flex size-52 items-center justify-center">
      <svg viewBox="0 0 200 200" className="absolute inset-0 -rotate-90">
        <circle cx="100" cy="100" r={R} fill="none" stroke="currentColor" strokeWidth="8" className="text-slate-100" />
        <circle
          cx="100"
          cy="100"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.max(0, Math.min(1, ratio)))}
          className={`transition-colors ${
            dim ? 'text-slate-300' : kind === 'focus' ? 'text-brand' : 'text-emerald-400'
          }`}
        />
      </svg>
      <div className="relative flex flex-col items-center">{children}</div>
    </div>
  )
}
