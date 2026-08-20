import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

/** 调试监控面板（开发用，独立窗口 /debug）：实时显示屏幕感知管线每一步 + 最近抓取的截图。 */
interface Ev {
  ts: number
  stage: string
  message: string
  image?: string
}

const STAGE: Record<string, { label: string; color: string }> = {
  tick: { label: '触发', color: 'text-slate-400' },
  frontapp: { label: '前台', color: 'text-sky-400' },
  skip: { label: '跳过', color: 'text-amber-400' },
  screenshot: { label: '截图', color: 'text-violet-400' },
  ocr: { label: 'OCR', color: 'text-emerald-400' },
  detect: { label: '检测', color: 'text-indigo-300' },
  record: { label: '记录', color: 'text-slate-300' },
  popup: { label: '弹卡', color: 'text-pink-400' },
  cloud: { label: '云端', color: 'text-orange-400' },
  error: { label: '错误', color: 'text-red-400' }
}

function hhmmss(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function Debug(): React.JSX.Element {
  const [events, setEvents] = useState<Ev[]>([])
  const [shot, setShot] = useState<{ url: string; ts: number } | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return api.on('guzi-assistant:debug', (p) => {
      const e = p as Ev
      if (e.image) setShot({ url: e.image, ts: e.ts })
      setEvents((prev) => [...prev.slice(-299), e])
    })
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [events])

  const last = events[events.length - 1]

  return (
    <div className="flex h-screen flex-col bg-[#0b0b0f] text-slate-200">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div className="text-sm font-semibold">调试监控面板</div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span>当前：{last ? (STAGE[last.stage]?.label ?? last.stage) : '待机'}</span>
          <button onClick={() => setEvents([])} className="rounded px-2 py-0.5 hover:bg-white/10">
            清空
          </button>
        </div>
      </div>

      <div className="shrink-0 border-b border-white/10 p-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
          <span>最近抓取的截图</span>
          {shot && <span>{hhmmss(shot.ts)}</span>}
        </div>
        {shot ? (
          <img src={shot.url} alt="最近截图" className="w-full rounded-md border border-white/10" />
        ) : (
          <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-white/10 text-xs text-slate-600">
            还没有截图（仅屏幕有变化时抓取）
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-5">
        {events.length === 0 && (
          <div className="text-slate-600">
            等待事件…（在微信 / 钉钉里出现带时间的内容时可看到管线流转）
          </div>
        )}
        {events.map((e, i) => {
          const s = STAGE[e.stage] ?? { label: e.stage, color: 'text-slate-300' }
          return (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-slate-600">{hhmmss(e.ts)}</span>
              <span className={`shrink-0 ${s.color}`}>[{s.label}]</span>
              <span className="min-w-0 break-words text-slate-300">{e.message}</span>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}
