import type { TaskRecord } from '@shared/types'
import ConfidenceBadge from './ConfidenceBadge'
import { fmtTime, ROLE_LABELS, TYPE_LABELS } from '../labels'

interface Props {
  task: TaskRecord
  onJoin: () => void
  onEdit: () => void
  onIgnore: () => void
  onNotMine: () => void
  onShowSource: () => void
}

export default function TaskCard({
  task,
  onJoin,
  onEdit,
  onIgnore,
  onNotMine,
  onShowSource
}: Props): React.JSX.Element {
  const highConfidence = task.confidence >= 0.85 && task.belongsToUser === 'yes'

  return (
    <div
      className={`rounded-xl border bg-white p-4 shadow-sm ${
        highConfidence ? 'border-indigo-300' : 'border-slate-200'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {TYPE_LABELS[task.itemType]}
        </span>
        <h3 className="min-w-0 flex-1 text-sm leading-5 font-medium">{task.title}</h3>
        <ConfidenceBadge value={task.confidence} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {task.startTime && <span>开始：{fmtTime(task.startTime)}</span>}
        {task.dueTime && <span className="text-red-500">截止：{fmtTime(task.dueTime)}</span>}
        {task.location && <span>地点:{task.location}</span>}
        <span>{ROLE_LABELS[task.userRole]}</span>
      </div>

      <div
        className={`mt-2 rounded-lg px-3 py-2 text-xs leading-5 ${
          task.belongsToUser === 'yes' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'
        }`}
      >
        {task.belongsToUser === 'yes' ? '判断属于你：' : '不确定是否属于你：'}
        {task.belongingReason || '无说明'}
      </div>

      {task.notes.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-slate-400 select-none hover:text-slate-600">
            注意事项（{task.notes.length}）
          </summary>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-xs leading-5 text-slate-600">
            {task.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      {task.evidence.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-slate-400 select-none hover:text-slate-600">
            原文证据（{task.evidence.length}）
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {task.evidence.map((ev, i) => (
              <blockquote
                key={i}
                className="border-l-2 border-slate-300 pl-2 text-xs leading-5 text-slate-600"
              >
                {ev}
              </blockquote>
            ))}
          </div>
        </details>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
        <button
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700"
          onClick={onJoin}
        >
          加入
        </button>
        <button
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          onClick={onEdit}
        >
          修改后加入
        </button>
        <button
          className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
          onClick={onIgnore}
        >
          忽略
        </button>
        <button
          className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
          onClick={onNotMine}
        >
          不是我的任务
        </button>
        <button
          className="ml-auto rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:text-indigo-600"
          onClick={onShowSource}
        >
          查看来源
        </button>
      </div>
    </div>
  )
}
