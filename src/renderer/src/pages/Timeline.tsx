import { useState } from 'react'
import type { TaskRecord, TaskStatus } from '@shared/types'
import { isFinishedEvent } from '@shared/task-filters'
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
      sub = n === 0 || n === 1 ? `${md(d)} ${WEEKDAY[d.getDay()]}` : n < 0 ? '已过去' : `${n} 天后`
    } else if (mode === 'week') {
      const mon = mondayOf(d)
      key = mon.toDateString()
      const thisMon = mondayOf(now)
      const weekDiff = Math.round((mon.getTime() - thisMon.getTime()) / (7 * 86400000))
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6)
      label = weekDiff === 0 ? '本周' : weekDiff === 1 ? '下周' : `${md(mon)} – ${md(sun)}`
      sub = weekDiff < 0 ? '已过去' : weekDiff <= 1 ? `${md(mon)} – ${md(sun)}` : `${weekDiff} 周后`
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
  const [showFinished, setShowFinished] = useState(false)

  const now = new Date()
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status))
  // 已结束的纯开始时间任务（开过的会等）：收进底部折叠区，不混在主时间轴/倒计时里（#9）
  const finished = active
    .filter((t) => isFinishedEvent(t, now))
    .sort((a, b) => timeOf(b)!.localeCompare(timeOf(a)!)) // 最近结束的在前
  const live = active.filter((t) => !isFinishedEvent(t, now))
  const overdue = live
    .filter((t) => t.status === 'overdue')
    .sort((a, b) => (timeOf(a) ?? '').localeCompare(timeOf(b) ?? ''))
  const timed = live
    .filter((t) => timeOf(t) && t.status !== 'overdue')
    .sort((a, b) => timeOf(a)!.localeCompare(timeOf(b)!))
  const unscheduled = live.filter((t) => !timeOf(t) && t.status !== 'overdue')

  // #10 去冗余（做减法）：顶部只置顶「真紧急」项（≤3 天内、非已延期）；已延期归「已延期」区、
  // 远期归下方分组，不再用「最近 3 条」与下方重复展示。无紧急项时该区自然消失。
  const upcoming = timed.filter((t) => daysUntil(timeOf(t)!) <= 3)
  const groups = buildGroups(timed, mode)

  return (
    <div className="page animate-page">
      <div className="page-head">
        <div className="page-title">时间轴</div>
        <div className="seg">
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
              className={mode === key ? 'on' : ''}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {upcoming.length > 0 && (
        <div className="up stagger">
          {upcoming.map((t) => {
            const time = timeOf(t)!
            const urgent = t.status === 'overdue' || daysUntil(time) <= 3
            const cd = countdownLabel(time)
            const label =
              t.status === 'overdue'
                ? daysUntil(time) === 0
                  ? '今天已超期'
                  : cd
                : cd === '今天已过' || daysUntil(time) < 0
                  ? t.dueTime
                    ? '已到期'
                    : '已开始'
                  : `${cd}${t.dueTime ? '截止' : '开始'}`
            return (
              <button
                key={t.id}
                onClick={() => setDetail(t)}
                className="up-row"
              >
                <span className="t">「{t.title}」</span>
                <span className={`cd${urgent ? ' urgent' : ''}`}>{label}</span>
                <span className="time">优先级：{PRIORITY_LABELS[t.priority]}</span>
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

      <div className="flex flex-col" style={{ marginTop: '6px' }}>
        {groups.map((g) => (
          <TimelineSection key={g.key} label={g.label} sub={g.sub} tasks={g.tasks} onOpen={setDetail} />
        ))}
        {!groups.length && !overdue.length && (
          <div className="empty" style={{ marginTop: '24px', textAlign: 'center' }}>
            还没有带时间的已确认任务。先去收件箱确认几条吧。
          </div>
        )}
      </div>

      {unscheduled.length > 0 && (
        <div style={{ marginTop: '20px', fontSize: '12px', color: 'var(--t3)' }}>
          另有 {unscheduled.length} 个任务未排期，可在「日程」页中设置时间。
        </div>
      )}

      {finished.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <button
            onClick={() => setShowFinished((v) => !v)}
            className="btn ghost sm"
          >
            {showFinished ? '▾' : '▸'} 已结束 {finished.length} 项（仅开始时间、已过去）
          </button>
          {showFinished && (
            <div style={{ marginTop: '8px', opacity: 0.7 }}>
              <TimelineSection label="已结束" sub={`${finished.length} 项`} tasks={finished} onOpen={setDetail} />
            </div>
          )}
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
    <section className={`tl-section${danger ? ' danger' : ''}`} style={danger ? { marginTop: '26px' } : {}}>
      <div className="axis"></div>
      <div className="node"></div>
      <div className="tl-head">
        <h2 className={danger ? 'is-danger' : ''}>{label}</h2>
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="tl-list stagger">
        {tasks.map((t) => {
          const time = t.dueTime ?? t.startTime
          const priorityDot =
            t.priority === 'high' ? 'dot high' :
            t.priority === 'medium' ? 'dot med' :
            t.priority !== 'unknown' ? 'dot low' : null
          return (
            <button
              key={t.id}
              onClick={() => onOpen(t)}
              className="row"
            >
              <span className="tag">{TYPE_LABELS[t.itemType]}</span>
              <span className="title">{t.title}</span>
              {t.location && <span className="meta">{t.location}</span>}
              {time && (
                <span className={`time${danger ? ' is-danger' : ''}`}>{fmtTime(time)}</span>
              )}
              {priorityDot && <span className={priorityDot}></span>}
            </button>
          )
        })}
      </div>
    </section>
  )
}
