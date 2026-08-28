// 专注页：番茄钟本体 + 今日统计 + 最近两周的专注曲线。
//
// 计时按 wall clock 算（记下 startAt，每半秒重算剩余），不做倒数累减——
// 窗口切后台会被节流，累减的计时器越走越慢，wall clock 不会。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_PREFS,
  focusLabel,
  formatCountdown,
  nextPhase,
  remainingSeconds,
  type DayStats,
  type PomodoroKind,
  type PomodoroPrefs,
  type PomodoroSession
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
}

interface Running {
  id: string
  startAt: string
  minutes: number
  kind: PomodoroKind
}

export default function PomodoroPage({ enabledPlugins }: PluginPageProps): React.JSX.Element {
  const timeblockEnabled = enabledPlugins.includes('timeblock')
  const [prefs, setPrefs] = useState<PomodoroPrefs>(DEFAULT_PREFS)
  const [running, setRunning] = useState<Running | null>(null)
  const [stats, setStats] = useState<DayStats>({ rounds: 0, focusMinutes: 0, abandoned: 0 })
  const [history, setHistory] = useState<{ date: string; rounds: number; focusMinutes: number }[]>([])
  const [remaining, setRemaining] = useState(0)
  const [queued, setQueued] = useState<{ kind: PomodoroKind; minutes: number; long: boolean } | null>(null)
  const [blocks, setBlocks] = useState<TimeBlock[]>([])
  const [blockId, setBlockId] = useState<string | null>(null)
  const finishing = useRef(false)

  const refresh = useCallback(async () => {
    const [today, hist] = await Promise.all([
      api.plugin<TodayPayload>('pomodoro', 'today'),
      api.plugin<{ date: string; rounds: number; focusMinutes: number }[]>('pomodoro', 'history', 14)
    ])
    setStats(today.stats)
    setHistory(hist)
  }, [])

  useEffect(() => {
    void api.plugin<PomodoroPrefs>('pomodoro', 'prefs').then(setPrefs)
    void api.plugin<PomodoroSession | null>('pomodoro', 'running').then((s) => {
      if (s) setRunning({ id: s.id, startAt: s.startAt, minutes: s.minutes, kind: s.kind })
    })
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
      if (!running || finishing.current) return
      finishing.current = true
      const wasFocus = running.kind === 'focus'
      await api.plugin('pomodoro', 'finish', running.id, completed)
      setRunning(null)
      const after = await api.plugin<TodayPayload>('pomodoro', 'today')
      setStats(after.stats)
      void api.plugin<{ date: string; rounds: number; focusMinutes: number }[]>('pomodoro', 'history', 14).then(setHistory)
      if (completed) {
        const next = nextPhase(running.kind, after.stats.rounds, prefs)
        setQueued(next)
        await api.plugin(
          'pomodoro',
          'say',
          wasFocus
            ? `一轮专注完成了，歇 ${next.minutes} 分钟吧`
            : '休息结束，接着来一轮？'
        )
      } else {
        setQueued(null)
      }
      finishing.current = false
    },
    [running, prefs]
  )

  useEffect(() => {
    if (!running) return
    const tick = (): void => {
      const left = remainingSeconds(running.startAt, running.minutes, Date.now())
      setRemaining(left)
      if (left <= 0) void finish(true)
    }
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [running, finish])

  const start = async (kind: PomodoroKind, minutes: number): Promise<void> => {
    const res = await api.plugin<{ id: string; startAt: string }>(
      'pomodoro',
      'start',
      kind,
      minutes,
      kind === 'focus' ? blockId : null,
      null
    )
    setQueued(null)
    setRunning({ id: res.id, startAt: res.startAt, minutes, kind })
  }

  const total = running ? running.minutes * 60 : 0
  const ratio = total ? 1 - remaining / total : 0
  const maxRounds = useMemo(() => Math.max(1, ...history.map((h) => h.rounds)), [history])

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">专注</h1>
        <p className="mt-0.5 text-xs text-slate-400">
          一轮专注加一轮休息。中途放弃也照样记下来——记录是为了看清自己，不是为了打分。
        </p>
      </header>

      <div className="mb-6 flex flex-col items-center rounded-xl border border-slate-200 bg-surface px-6 py-10 shadow-sm">
        <Dial ratio={ratio} kind={running?.kind ?? queued?.kind ?? 'focus'}>
          <div className="text-4xl font-semibold tabular-nums">
            {running ? formatCountdown(remaining) : formatCountdown(prefs.focusMin * 60)}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {running
              ? running.kind === 'focus'
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
        </Dial>

        {timeblockEnabled && !running && blocks.length > 0 && (
          <label className="mt-5 flex items-center gap-2 text-xs text-slate-400">
            关联时间块
            <select
              value={blockId ?? ''}
              onChange={(e) => setBlockId(e.target.value || null)}
              className="rounded-md border border-slate-200 px-2 py-1 text-slate-600 outline-none focus:border-brand"
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

        <div className="mt-6 flex gap-3">
          {running ? (
            <button
              onClick={() => void finish(false)}
              className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-500 hover:border-slate-300"
            >
              放弃这一轮
            </button>
          ) : queued ? (
            <>
              <button
                onClick={() => void start(queued.kind, queued.minutes)}
                className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white"
              >
                开始{queued.kind === 'break' ? `休息 ${queued.minutes} 分钟` : '下一轮'}
              </button>
              <button
                onClick={() => setQueued(null)}
                className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-500"
              >
                先停一下
              </button>
            </>
          ) : (
            <button
              onClick={() => void start('focus', prefs.focusMin)}
              className="rounded-lg bg-brand px-6 py-2 text-sm font-medium text-white"
            >
              开始专注 {prefs.focusMin} 分钟
            </button>
          )}
        </div>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-4">
        <Stat label="今天完成" value={`${stats.rounds} 轮`} />
        <Stat label="专注时长" value={focusLabel(stats.focusMinutes)} />
        <Stat label="中途放弃" value={`${stats.abandoned} 轮`} muted />
      </div>

      <Section title="最近两周" desc="每天完成的专注轮数">
        <div className="flex h-24 items-end gap-1.5">
          {history.map((h) => (
            <div key={h.date} className="flex flex-1 flex-col items-center gap-1">
              <div
                title={`${h.date}：${h.rounds} 轮 · ${focusLabel(h.focusMinutes)}`}
                className={`w-full rounded-t ${h.rounds ? 'bg-brand/70' : 'bg-slate-100'}`}
                style={{ height: `${Math.max(3, (h.rounds / maxRounds) * 100)}%` }}
              />
              <span className="text-[10px] text-slate-300 tabular-nums">{h.date.slice(8)}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
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

/** 环形进度：一圈就是这一轮，走完即满。 */
function Dial({
  ratio,
  kind,
  children
}: {
  ratio: number
  kind: PomodoroKind
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
          className={kind === 'focus' ? 'text-brand' : 'text-emerald-400'}
        />
      </svg>
      <div className="relative flex flex-col items-center">{children}</div>
    </div>
  )
}
