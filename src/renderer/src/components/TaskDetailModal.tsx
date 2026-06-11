import type { TaskRecord } from '@shared/types'
import ConfidenceBadge from './ConfidenceBadge'
import {
  countdownLabel,
  fmtTime,
  PRIORITY_LABELS,
  ROLE_LABELS,
  STATUS_LABELS,
  TYPE_LABELS
} from '../labels'

interface Props {
  task: TaskRecord
  onShowSource: () => void
  onClose: () => void
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  )
}

export default function TaskDetailModal({ task, onShowSource, onClose }: Props): React.JSX.Element {
  const due = task.dueTime ?? task.startTime
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[84vh] w-[580px] flex-col rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 border-b border-slate-100 p-5 pb-4">
          <span className="mt-1 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
            {TYPE_LABELS[task.itemType]}
          </span>
          <h3 className="min-w-0 flex-1 text-base leading-6 font-semibold">{task.title}</h3>
          <span className="mt-1 shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
            {STATUS_LABELS[task.status]}
          </span>
          <button className="mt-0.5 px-1 text-slate-400 hover:text-slate-600" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {task.startTime && <Field label="开始时间">{fmtTime(task.startTime)}</Field>}
            {task.dueTime && (
              <Field label="截止时间">
                <span className="text-red-500">{fmtTime(task.dueTime)}</span>
              </Field>
            )}
            {due && task.status !== 'done' && (
              <Field label="倒计时">
                <span className={task.status === 'overdue' ? 'text-red-500' : 'text-indigo-600'}>
                  {countdownLabel(due)}
                </span>
              </Field>
            )}
            {task.location && <Field label="地点">{task.location}</Field>}
            <Field label="优先级">{PRIORITY_LABELS[task.priority]}</Field>
            <Field label="我的角色">{ROLE_LABELS[task.userRole]}</Field>
            <Field label="归属置信度">
              <ConfidenceBadge value={task.confidence} />
            </Field>
          </div>

          <div
            className={`mt-4 rounded-lg px-3 py-2 text-xs leading-5 ${
              task.belongsToUser === 'yes'
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-amber-50 text-amber-800'
            }`}
          >
            {task.belongsToUser === 'yes' ? '判断属于你：' : '不确定是否属于你：'}
            {task.belongingReason || '无说明'}
          </div>

          {task.notes.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-medium text-slate-400">注意事项</h4>
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-6 text-slate-700">
                {task.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ol>
            </div>
          )}

          {task.evidence.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-medium text-slate-400">原文证据</h4>
              <div className="flex flex-col gap-1.5">
                {task.evidence.map((ev, i) => (
                  <blockquote
                    key={i}
                    className="border-l-2 border-slate-300 pl-2 text-xs leading-5 text-slate-600"
                  >
                    {ev}
                  </blockquote>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-4">
          {task.sourceId && (
            <button
              className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
              onClick={onShowSource}
            >
              查看来源原文
            </button>
          )}
          <button
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs text-white hover:bg-indigo-700"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
