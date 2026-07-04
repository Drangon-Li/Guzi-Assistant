import { useEffect, useRef, useState } from 'react'
import type { CandidateContext, ParsedItem } from '@shared/parsing'
import type { TaskStatus } from '@shared/types'
import { api } from '../api'
import { fmtTime } from '../labels'
import Markdown from '../components/Markdown'
import brandMark from '../assets/agent-avatar.png'

interface OpRow {
  id: string
  title: string
  action: 'done' | 'ignored'
  prevStatus: TaskStatus
  undone?: boolean
}

interface Msg {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** 模型直接执行的添加结果（「✓ 已加入…」/「…已存在」小字） */
  addedNotes?: string[]
  /** 口头指令已执行的任务操作：可一键撤销（恢复原状态） */
  ops?: OpRow[]
  /** 待确认候选：行内「加入」按钮，也可下一轮用嘴确认（ctx 会随对话传回） */
  candidates?: { ctx: CandidateContext; added: Record<number, 'added' | 'duplicate'> }
}

/** 快捷提问框（#/quickbar）：全局快捷键唤起的独立气泡对话模式。
 *  窗口本体是 vibrancy 磨砂卡（Spotlight 式），对话区在上、输入条在下、一张卡到底。
 *  Enter 单入口：问答/记日程/口头指令（「XX 做完了标记完成」，带一键撤销）都走助手；
 *  Esc/失焦收起。每次唤起都是全新对话（用户明确要求：⌥Space 即新会话）。 */
export default function QuickBar(): React.JSX.Element {
  const [text, setText] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  // 每次唤起 +1：重放内容的入场动画（配合主进程的窗口透明度渐变）
  const [showNonce, setShowNonce] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const idRef = useRef(0)

  // 每次唤起：全新对话（清空气泡与输入）、聚焦
  useEffect(() => {
    return api.on('eshell:quickbar-show', () => {
      setMsgs([])
      setText('')
      setBusy(false)
      setShowNonce((n) => n + 1)
      inputRef.current?.focus()
    })
  }, [])

  // 内容高度变化（气泡展开/收起）→ 主进程按底边固定调整窗口高度
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      void api.quickbarResize(Math.ceil(el.getBoundingClientRect().height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 新消息滚到底（唤起重放动画会重挂列表节点，也要补一次）
  useEffect(() => {
    const l = listRef.current
    if (l) l.scrollTop = l.scrollHeight
  }, [msgs, busy, showNonce])

  const ask = async (): Promise<void> => {
    const q = text.trim()
    if (!q || busy) return
    setText('')
    const mine: Msg = { id: ++idRef.current, role: 'user', content: q }
    const nextMsgs = [...msgs, mine]
    setMsgs(nextMsgs)
    setBusy(true)
    try {
      const history = nextMsgs.map((m) => ({ role: m.role, content: m.content }))
      // 最近一轮候选作为上下文传回：用户可以用嘴确认（「把第一个加上」）
      const ctx = [...msgs].reverse().find((m) => m.candidates)?.candidates?.ctx ?? null
      const res = await api.assistantChat({ history, candidates: ctx })
      const reply: Msg = {
        id: ++idRef.current,
        role: 'assistant',
        content: res.error ? `出错了：${res.error}` : res.reply || '（无回复）'
      }
      if (!res.error) {
        if (res.added.length)
          reply.addedNotes = res.added.map((a) =>
            a.duplicate ? `「${a.title}」已存在，未重复添加` : `✓ 已加入「${a.title}」`
          )
        if (res.ops.length) reply.ops = res.ops
        if (res.candidates?.length)
          reply.candidates = { ctx: { sourceText: q, items: res.candidates }, added: {} }
      }
      setMsgs((m) => [...m, reply])
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: ++idRef.current, role: 'assistant', content: e instanceof Error ? e.message : String(e) }
      ])
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const addCandidate = async (msgId: number, idx: number, ctx: CandidateContext, item: ParsedItem): Promise<void> => {
    const info = await api.assistantAdd({ sourceText: ctx.sourceText, item })
    setMsgs((ms) =>
      ms.map((m) =>
        m.id === msgId && m.candidates
          ? {
              ...m,
              candidates: {
                ...m.candidates,
                added: { ...m.candidates.added, [idx]: info.duplicate ? 'duplicate' : 'added' }
              }
            }
          : m
      )
    )
  }

  // 撤销口头指令的任务操作：恢复原状态（tasks:update 会广播刷新各处列表）
  const undoOp = async (msgId: number, idx: number, op: OpRow): Promise<void> => {
    await api.updateTask(op.id, { status: op.prevStatus })
    setMsgs((ms) =>
      ms.map((m) =>
        m.id === msgId && m.ops ? { ...m, ops: m.ops.map((o, i) => (i === idx ? { ...o, undone: true } : o)) } : m
      )
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return // 中文输入法上屏的 Enter 不当提交
    if (e.key === 'Escape') void api.quickbarHide()
    if (e.key !== 'Enter') return
    e.preventDefault()
    // 记日程与问答同走助手（明确的添加请求模型会当轮直接加入），不再单设 ⌘Enter 通道
    void ask()
  }

  return (
    <div className="flex h-screen w-screen flex-col justify-end overflow-hidden">
      <div ref={boxRef} className="flex flex-col">
        {/* 半透明 surface 水洗：磨砂亮度随背后内容浮动（深色背景会把浅色磨砂压成中灰，
            文字直接打在裸磨砂上对比不稳，用户实测发糊）。70% 语义底色 + slate-600 级文字，
            四种「主题×背景」组合按合成算术对比度均 ≥4.2:1，磨砂质感仍透出 */}
        <div key={showNonce} className="animate-modal-in flex flex-col bg-surface/70">
        {(msgs.length > 0 || busy) && (
          <div
            ref={listRef}
            className="flex max-h-[380px] flex-col gap-2.5 overflow-y-auto border-b border-slate-200/70 p-3.5"
          >
            {msgs.map((m) =>
              m.role === 'user' ? (
                <div
                  key={m.id}
                  className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-brand px-3 py-1.5 text-sm leading-6 text-white"
                >
                  {m.content}
                </div>
              ) : (
                <div key={m.id} className="flex max-w-[92%] flex-col gap-1.5 self-start">
                  <div className="rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2">
                    <Markdown text={m.content} />
                  </div>
                  {m.addedNotes?.map((n, i) => (
                    <div key={i} className="pl-1 text-xs text-emerald-600">
                      {n}
                    </div>
                  ))}
                  {m.ops?.map((o, i) => (
                    <div key={`op-${i}`} className="flex items-center gap-2 pl-1 text-xs">
                      <span className={o.undone ? 'text-slate-400 line-through' : 'text-emerald-600'}>
                        {o.action === 'done' ? `✓ 已完成：${o.title}` : `已忽略：${o.title}`}
                      </span>
                      {o.undone ? (
                        <span className="text-slate-400">已撤销</span>
                      ) : (
                        <button
                          className="text-slate-400 underline-offset-2 hover:text-brand hover:underline"
                          onClick={() => void undoOp(m.id, i, o)}
                        >
                          撤销
                        </button>
                      )}
                    </div>
                  ))}
                  {m.candidates?.ctx.items.map((item, idx) => {
                    const state = m.candidates!.added[idx]
                    return (
                      <div
                        key={idx}
                        className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-1.5 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                        {(item.start_time || item.due_time) && (
                          <span className="shrink-0 text-slate-400">
                            {fmtTime(item.start_time ?? item.due_time!)}
                          </span>
                        )}
                        {state ? (
                          <span className="shrink-0 text-slate-400">
                            {state === 'added' ? '✓ 已加入' : '已存在'}
                          </span>
                        ) : (
                          <button
                            className="shrink-0 rounded-md bg-brand px-2 py-0.5 text-white hover:bg-brand-dark"
                            onClick={() => void addCandidate(m.id, idx, m.candidates!.ctx, item)}
                          >
                            加入
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            )}
            {busy && (
              <div className="self-start rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2.5">
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="size-1.5 animate-bounce rounded-full bg-slate-400"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 px-4 py-3.5">
          <img src={brandMark} alt="" className="size-7 shrink-0 rounded-lg" draggable={false} />
          <input
            ref={inputRef}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[15px] text-slate-800 outline-none placeholder:text-slate-600"
            placeholder={msgs.length ? '继续问…' : '问谷子任何事，或说一件要记的日程…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="shrink-0 text-[11px] text-slate-600">
            {msgs.length ? '⏎ 发送 · Esc 退出' : '⏎ 问助手或记日程 · Esc 关闭'}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
