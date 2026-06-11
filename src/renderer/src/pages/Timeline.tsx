import { useState } from 'react'
import type { TaskRecord, TaskStatus } from '@shared/types'
import {
  countdownLabel,
  daysUntil,
  fmtTime,
  PRIORITY_LABELS,
  TYPE_LABELS
} from '../labels'
import TaskDetailModal from '../components/TaskDetailModal'
import SourceModal from '../components/SourceModal'

interface Props {
  tasks: TaskRecord[]
}

type ViewMode = 'day' | 'week' | 'month'

const ACTIVE_STATUSES: TaskStatus[] = ['not_started', 'scheduled', 'in_progress', 'overdue']
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function timeOf(t: TaskRecord): string | null {
  return t.dueTime ?? t.startTime
}

function mondayOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
}

function md(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

interface Group {
  key: string
  label: string
  sub: string
  tasks: TaskRecord[]
}

function buildGroups(timed: TaskRecord[], mode: ViewMode): Group[] {
  const map = new Map<string, Group>()
  const now = new Date()
  for (const task of timed) {
    const d = new Date(timeOf(task)!)
    let key: string
    let label: string
    let sub = ''
    if (mode === 'day') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const n = daysUntil(timeOf(task)!)
      label = n === 0 ? '今天' : n === 1 ? '明天' : `${md(d)} ${WEEKDAY[d.getDay()]}`
      sub = n === 0 || n === 1 ? `${md(d)} ${WEEKDAY[d.getDay()]}` : `${n} 天后`
    } else if (mode === 'week') {
      const mon = mondayOf(d)
      key = mon.toDateString()
      const thisMon = mondayOf(now)
      const weekDiff = Math.round((mon.getTime() - thisMon.getTime()) / (7 * 86400000))
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6)
      label = weekDiff === 0 ? '本周' : weekDiff === 1 ? '下周' : `${md(mon)} – ${md(sun)}`
      sub = weekDiff <= 1 ? `${md(mon)} – ${md(sun)}` : `${weekDiff} 周后`
    } else {
      key = `${d.getFullYear()}-${d.getMonth()}`
      label =
        d.getFullYear() === now.getFullYear()
          ? `${d.getMonth() + 1}月`
          : `${d.getFullYear()}年${d.getMonth() + 1}月`
      sub =
        d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() ? '本月' : ''
    }
    const group = map.get(key) ?? { key, label, sub, tasks: [] }
    group.tasks.push(task)
    map.set(key, group)
  }
  return [...map.values()]
}

export default function Timeline({ tasks }: Props): React.JSX.Element {
  const [mode, setMode] = useState<ViewMode>('day')
  const [detail, setDetail] = useState<TaskRecord | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)

  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status))
  const overdue = active
    .filter((t) => t.status === 'overdue')
    .sort((a, b) => (timeOf(a) ?? '').localeCompare(timeOf(b) ?? ''))
  const timed = active
    .filter((t) => timeOf(t) && t.status !== 'overdue')
    .sort((a, b) => timeOf(a)!.localeCompare(timeOf(b)!))
  const unscheduled = active.filter((t) => !timeOf(t) && t.status !== 'overdue')

  const upcoming = active
    .filter((t) => timeOf(t))
    .sort((a, b) => timeOf(a)!.localeCompare(timeOf(b)!))
  const groups = buildGroups(timed, mode)

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">时间轴</h1>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
          {(
            [
              ['day', '天'],
              ['week', '周'],
              ['month', '月']
            ] as [ViewMode, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`rounded-md px-3 py-1 ${
                mode === key ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {upcoming.length > 0 && (
        <div className="mt-5 flex flex-col gap-2">
          {upcoming.map((t) => {
            const time = timeOf(t)!
            const urgent = t.status === 'overdue' || daysUntil(time) <= 3
            const label =
              t.status === 'overdue'
                ? daysUntil(time) === 0
                  ? '今天已超期'
                  : countdownLabel(time)
                : `${countdownLabel(time)}${t.dueTime ? '截止' : '开始'}`
            return (
              <button
                key={t.id}
                onClick={() => setDetail(t)}
                className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 text-left shadow-sm ${
                  urgent ? 'border-red-200 bg-red-50/60' : 'border-indigo-100 bg-indigo-50/60'
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">「{t.title}」</span>
                <span
                  className={`shrink-0 text-sm font-semibold ${urgent ? 'text-red-600' : 'text-indigo-600'}`}
                >
                  {label}
                </span>
                <span className="shrink-0 text-xs text-slate-400">
                  优先级：{PRIORITY_LABELS[t.priority]}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {overdue.length > 0 && (
        <TimelineSection
          label="已延期"
          sub={`${overdue.length} 项`}
          tasks={overdue}
          danger
          onOpen={setDetail}
        />
      )}

      <div className="mt-6 flex flex-col">
        {groups.map((g) => (
          <TimelineSection key={g.key} label={g.label} sub={g.sub} tasks={g.tasks} onOpen={setDetail} />
        ))}
        {!groups.length && !overdue.length && (
          <div className="mt-10 text-center text-sm text-slate-400">
            还没有带时间的已确认任务。先去收件箱确认几条吧。
          </div>
        )}
      </div>

      {unscheduled.length > 0 && (
        <div className="mt-6 text-xs text-slate-400">
          另有 {unscheduled.length} 个任务未排期，可在「日程」页中设置时间。
        </div>
      )}

      {detail && (
        <TaskDetailModal
          task={detail}
          onClose={() => setDetail(null)}
          onShowSource={() => detail.sourceId && setSourceId(detail.sourceId)}
        />
      )}
      {sourceId && <SourceModal sourceId={sourceId} onClose={() => setSourceId(null)} />}
    </div>
  )
}

function TimelineSection({
  label,
  sub,
  tasks,
  danger,
  onOpen
}: {
  label: string
  sub: string
  tasks: TaskRecord[]
  danger?: boolean
  onOpen: (t: TaskRecord) => void
}): React.JSX.Element {
  return (
    <section className={`relative pb-6 pl-6 ${danger ? 'mt-6' : ''}`}>
      <div className="absolute top-1.5 bottom-0 left-[5px] w-px bg-slate-200" />
      <div
        className={`absolute top-1.5 left-0 size-[11px] rounded-full border-2 bg-white ${
          danger ? 'border-red-400' : 'border-indigo-400'
        }`}
      />
      <div className="flex items-baseline gap-2">
        <h2 className={`text-sm font-semibold ${danger ? 'text-red-600' : ''}`}>{label}</h2>
        {sub && <span className="text-xs text-slate-400">{sub}</span>}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {tasks.map((t) => {
          const time = t.dueTime ?? t.startTime
          return (
            <button
              key={t.id}
              onClick={() => onOpen(t)}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-left shadow-sm hover:border-indigo-300"
            >
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                {TYPE_LABELS[t.itemType]}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
              {t.location && (
                <span className="hidden shrink-0 text-xs text-slate-400 sm:inline">{t.location}</span>
              )}
              {time && (
                <span className={`shrink-0 text-xs ${danger ? 'text-red-500' : 'text-slate-500'}`}>
                  {fmtTime(time)}
                </span>
              )}
              {t.priority !== 'unknown' && (
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
                    t.priority === 'high'
                      ? 'bg-red-100 text-red-600'
                      : t.priority === 'medium'
                        ? 'bg-amber-100 text-amber-600'
                        : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {PRIORITY_LABELS[t.priority]}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
