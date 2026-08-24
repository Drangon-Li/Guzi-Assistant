import { useEffect, useRef, useState } from 'react'
import type { ReminderCardItem, ReminderPayload } from '@shared/types'
import { reminderWhenLabel } from '@shared/task-reminder'
import { api } from '../api'
import brandMark from '../assets/agent-avatar.png'

const SNOOZE_CHOICES = [5, 15, 60]

/** 任务提醒卡：不自动消失，用户必须处理才收。多条到点时在卡内排队，逐条处理。 */
export default function ReminderCard(): React.JSX.Element | null {
  // 三段状态放一个对象：updater 必须是纯的（StrictMode 会重复调用），
  // 所以关窗这类副作用只在事件处理里做，不放进 setState 回调。
  const [queue, setQueue] = useState<{ items: ReminderCardItem[]; processed: number; overflow: number }>({
    items: [],
    processed: 0,
    overflow: 0
  })

  const boxRef = useRef<HTMLDivElement | null>(null)

  // 内容高度变化（多条队列、注意事项、溢出行）→ 主进程按顶边固定调整窗口高度。
  // 窗口本体就是磨砂卡，高度不跟着内容走就会露出一截空磨砂。
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      void api.reminderResize(Math.ceil(el.getBoundingClientRect().height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    return api.on('guzi-assistant:reminder', (p) => {
      const payload = p as ReminderPayload
      setQueue((prev) => {
        // 卡还开着时又到点一批：追加而不是替换，别把用户没处理完的顶掉
        const seen = new Set(prev.items.map((item) => item.taskId))
        return {
          items: [...prev.items, ...payload.items.filter((item) => !seen.has(item.taskId))],
          processed: prev.processed,
          overflow: prev.overflow + payload.overflow
        }
      })
    })
  }, [])

  const current = queue.items[0]
  if (!current) return null

  const advance = (): void => {
    const rest = queue.items.slice(1)
    if (rest.length) {
      setQueue({ items: rest, processed: queue.processed + 1, overflow: queue.overflow })
      return
    }
    setQueue({ items: [], processed: 0, overflow: 0 })
    void api.reminderClose()
  }

  const done = (): void => {
    void api.reminderDone(current.taskId)
    advance()
  }
  const snooze = (minutes: number): void => {
    void api.reminderSnooze(current.taskId, minutes)
    advance()
  }

  const total = queue.processed + queue.items.length
  const index = queue.processed + 1
  const overdue = current.kind === 'catchup'

  return (
    // 窗口本体已是原生磨砂卡（圆角和阴影都由 macOS 画），这里不再套第二层卡片，
    // 否则会出现「卡中卡」。bg-surface/70 是水洗层：文字直接打在裸磨砂上，
    // 背景深浅一变对比度就不稳（quickbar 已实测踩过）。
    <div className="w-screen">
      <div ref={boxRef} className="flex w-full flex-col gap-2.5 bg-surface/70 p-4 text-sm">
        <div className="flex items-center gap-2">
          <img src={brandMark} alt="" className="size-4 shrink-0" />
          <span className="text-xs font-medium text-slate-500">任务提醒</span>
          {total > 1 && (
            <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-500">
              {index}/{total}
            </span>
          )}
        </div>

        <div className="font-medium leading-6 text-slate-800">{current.title}</div>

        <div className={`text-xs ${overdue ? 'text-amber-600' : 'text-brand'}`}>
          {reminderWhenLabel(current, new Date())}
          {current.location && <span className="ml-2 text-slate-400">{current.location}</span>}
        </div>

        {current.notes.length > 0 && (
          <ul className="max-h-20 list-disc overflow-y-auto pl-4 text-xs leading-5 text-slate-500">
            {current.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span>稍后</span>
          {SNOOZE_CHOICES.map((minutes) => (
            <button
              key={minutes}
              className="rounded-md border border-slate-400/25 px-2 py-0.5 text-slate-500 hover:bg-slate-500/10"
              onClick={() => snooze(minutes)}
            >
              {minutes < 60 ? `${minutes} 分钟` : '1 小时'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            className="text-xs text-slate-400 hover:text-slate-600"
            onClick={() => void api.reminderOpenSchedule()}
          >
            打开日程
          </button>
          <button className="ml-auto rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-500/10" onClick={advance}>
            知道了
          </button>
          <button
            className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark"
            onClick={done}
          >
            完成
          </button>
        </div>

        {queue.overflow > 0 && (
          <div className="text-[11px] text-slate-400">另有 {queue.overflow} 件到点，去日程页查看</div>
        )}
      </div>
    </div>
  )
}
