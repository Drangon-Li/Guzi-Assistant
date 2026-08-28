import { useEffect, useRef, useState } from 'react'
import type { TaskRecord } from '@shared/types'
import type { CandidateContext, ChatHistoryItem, ParsedItem } from '@shared/parsing'
import { api } from '../api'
import { fmtTime, summaryToast, TYPE_LABELS } from '../labels'
import ConfidenceBadge from './ConfidenceBadge'
import TaskDetailModal from './TaskDetailModal'
import SourceModal from './SourceModal'
import agentAvatar from '../assets/agent-avatar.png'

interface Props {
  tasks: TaskRecord[]
  showToast: (msg: string) => void
  hotkeyLabel: string
  userName: string
  /** 外部注入一条消息并自动发送（如桌宠拖入文件）：display 为气泡显示文本，content 为发给助手的完整内容。nonce 变化触发一次。 */
  injected?: { content: string; display: string; nonce: number } | null
}

type AddState = 'added' | 'duplicate'

interface ChatMsg {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** 气泡显示用文本（缺省=text）；用于「拖入文件」时显示短标签而非整篇内容 */
  displayText?: string
  error?: boolean
  candidates?: { ctx: CandidateContext; added: Record<number, AddState> }
  /** 完全重复被拦下后，提供「仍要加入」的强制添加入口 */
  forceAdd?: { msgId: number; idx1: number; sourceText: string; item: ParsedItem; used?: boolean }
}

// 模块级缓存：切换页面不丢对话（应用重启后清空）
const store: { msgs: ChatMsg[]; nextId: number } = { msgs: [], nextId: 1 }

const SUGGESTIONS = ['今天有什么日程？', '哪些日程比较紧急？', '我现在应该干什么？']

function joinStatus(t: { startTime?: string | null; dueTime?: string | null }): 'scheduled' | 'not_started' {
  return t.dueTime || t.startTime ? 'scheduled' : 'not_started'
}

function Avatar({ role, initial }: { role: 'user' | 'assistant'; initial: string }): React.JSX.Element {
  if (role === 'assistant') {
    return <img src={agentAvatar} alt="谷子助手" className="size-8 shrink-0 rounded-[9px]" />
  }
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#8a7aa0] text-xs font-semibold text-white">
      {initial}
    </div>
  )
}

export default function AssistantChat({
  tasks,
  showToast,
  hotkeyLabel,
  userName,
  injected
}: Props): React.JSX.Element {
  const [msgs, setMsgs] = useState<ChatMsg[]>(store.msgs)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<TaskRecord | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [screenSense, setScreenSense] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const pending = tasks.filter((t) => t.status === 'pending')

  const update = (next: ChatMsg[]): void => {
    store.msgs = next
    setMsgs(next)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs.length, busy, pending.length])

  useEffect(() => {
    const load = (): void => {
      void api.getSettings().then((s) => setScreenSense(s.screenSenseEnabled))
    }
    load()
    return api.on('guzi-assistant:settings-updated', load)
  }, [])

  /** 最近一条仍有未处理候选的消息，作为下一轮对话的上下文 */
  const activeCandidates = (): CandidateContext | null => {
    for (let i = store.msgs.length - 1; i >= 0; i--) {
      const c = store.msgs[i].candidates
      if (c) {
        const remaining = c.ctx.items.some((_, idx) => !c.added[idx + 1])
        return remaining ? c.ctx : null
      }
    }
    return null
  }

  const send = async (raw: string, displayText?: string): Promise<void> => {
    const value = raw.trim()
    if (!value || busy) return
    setInput('')
    update([...store.msgs, { id: store.nextId++, role: 'user', text: value, displayText }])
    setBusy(true)
    const ctx = activeCandidates()
    const history: ChatHistoryItem[] = store.msgs
      .filter((m) => m.text && !m.error)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.text }))
    const res = await api.assistantChat({ history, candidates: ctx })
    setBusy(false)

    if (res.error) {
      update([...store.msgs, { id: store.nextId++, role: 'assistant', text: `出错了：${res.error}`, error: true }])
      return
    }
    // 对话指令加入的候选 → 标记对应卡片
    const dupMsgs: ChatMsg[] = []
    if (res.added.length && ctx) {
      const ctxMsg = store.msgs.find((m) => m.candidates?.ctx === ctx)
      store.msgs = store.msgs.map((m) =>
        m.candidates?.ctx === ctx
          ? {
              ...m,
              candidates: {
                ...m.candidates,
                added: {
                  ...m.candidates.added,
                  ...Object.fromEntries(res.added.map((a) => [a.candidate, a.duplicate ? 'duplicate' : 'added']))
                }
              }
            }
          : m
      )
      for (const a of res.added) {
        if (a.duplicate && a.item) {
          dupMsgs.push({
            id: store.nextId++,
            role: 'assistant',
            text: `「${a.title}」和已有任务完全相同，我先没有加。确定要重复添加的话点下面的按钮，或者回复"仍要添加"。`,
            forceAdd: { msgId: ctxMsg?.id ?? 0, idx1: a.candidate, sourceText: ctx.sourceText, item: a.item }
          })
        }
      }
    }
    const reply: ChatMsg = { id: store.nextId++, role: 'assistant', text: res.reply }
    if (res.candidates?.length) {
      reply.candidates = { ctx: { sourceText: value, items: res.candidates }, added: {} }
    }
    // 插件动作的结果单独一条：模型的 reply 可能只是「好的」，真正做没做成以这条为准
    const actionMsgs: ChatMsg[] = res.actions.map((a) => ({
      id: store.nextId++,
      role: 'assistant' as const,
      text: a.ok ? `✓ ${a.message}` : `没能执行：${a.message}`,
      error: !a.ok
    }))
    update([...store.msgs, reply, ...actionMsgs, ...dupMsgs])
  }

  // 外部注入消息（桌宠拖入文件）：nonce 变化时自动发送一次
  const injectedNonce = useRef(0)
  useEffect(() => {
    if (injected && injected.nonce !== injectedNonce.current) {
      injectedNonce.current = injected.nonce
      void send(injected.content, injected.display)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injected])

  const forceAddNow = async (m: ChatMsg): Promise<void> => {
    if (!m.forceAdd || m.forceAdd.used) return
    const { msgId, idx1, sourceText, item } = m.forceAdd
    const info = await api.assistantAdd({ sourceText, item, force: true })
    store.msgs = store.msgs.map((x) => {
      if (x.id === m.id && x.forceAdd) return { ...x, forceAdd: { ...x.forceAdd, used: true } }
      if (x.id === msgId && x.candidates)
        return { ...x, candidates: { ...x.candidates, added: { ...x.candidates.added, [idx1]: 'added' } } }
      return x
    })
    update([
      ...store.msgs,
      {
        id: store.nextId++,
        role: 'assistant',
        text: `好的，已重复加入「${info.title}」${info.time ? `（${fmtTime(info.time)}）` : ''}。`
      }
    ])
  }

  const addCandidate = async (msgId: number, idx1: number, ctx: CandidateContext, item: ParsedItem): Promise<void> => {
    const info = await api.assistantAdd({ sourceText: ctx.sourceText, item })
    store.msgs = store.msgs.map((m) =>
      m.id === msgId && m.candidates
        ? { ...m, candidates: { ...m.candidates, added: { ...m.candidates.added, [idx1]: info.duplicate ? 'duplicate' : 'added' } } }
        : m
    )
    const confirm: ChatMsg = info.duplicate
      ? {
          id: store.nextId++,
          role: 'assistant',
          text: `「${info.title}」和已有任务完全相同，我先没有加。确定要重复添加的话点下面的按钮。`,
          forceAdd: { msgId, idx1, sourceText: ctx.sourceText, item: info.item ?? item }
        }
      : {
          id: store.nextId++,
          role: 'assistant',
          text: `已加入「${info.title}」${info.time ? `（${fmtTime(info.time)}）` : ''}，可以在日程里查看。`
        }
    update([...store.msgs, confirm])
  }

  const screenshot = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const summary = await api.captureScreenshot()
      showToast(summary ? summaryToast(summary) : '已取消截图')
    } catch (e) {
      showToast(`截图失败：${e instanceof Error ? e.message : String(e)}（请检查屏幕录制权限）`)
    } finally {
      setBusy(false)
    }
  }

  const scanScreen = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.screenScan()
      showToast(r.message)
    } catch (e) {
      showToast(`扫描失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const joinAllPending = async (): Promise<void> => {
    const withTime = pending.filter((t) => t.dueTime || t.startTime).map((t) => t.id)
    const withoutTime = pending.filter((t) => !t.dueTime && !t.startTime).map((t) => t.id)
    if (withTime.length) await api.bulkTasks(withTime, 'scheduled')
    if (withoutTime.length) await api.bulkTasks(withoutTime, 'not_started')
    showToast(`已加入 ${pending.length} 个任务`)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-6">
          {msgs.length === 0 && (
            <div className="flex gap-3">
              <Avatar role="assistant" initial="纸" />
              <div className="flex max-w-[82%] flex-col gap-3">
                <div className="select-text rounded-2xl rounded-tl-sm bg-elevated px-4 py-3 text-sm leading-6">
                  你好，我是谷子。我会自动留意你设备上的通知、消息和聊天记录，从中帮你拎出该办的事，主动提给你确认；你也可以直接问我日程安排。
                  <span className="mt-1 block text-xs text-slate-400">
                    （需要时也能手动把内容发我：复制后按 {hotkeyLabel}）
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end gap-3">
                <div className="select-text max-w-[82%] rounded-2xl rounded-tr-sm bg-userbubble px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap text-slate-800 shadow-sm">
                  {m.displayText ?? m.text}
                </div>
                <Avatar role="user" initial={userName.slice(0, 1) || '我'} />
              </div>
            ) : (
              <div key={m.id} className="flex gap-3">
                <Avatar role="assistant" initial="纸" />
                <div className="flex max-w-[82%] min-w-0 flex-col gap-2">
                  <div
                    className={`select-text rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap ${
                      m.error ? 'border border-red-200 bg-red-50 text-red-600' : 'bg-elevated'
                    }`}
                  >
                    {m.text}
                  </div>
                  {m.forceAdd && !m.forceAdd.used && (
                    <button
                      className="self-start rounded-lg border border-amber-300 px-3 py-1 text-xs text-amber-700 hover:bg-amber-50"
                      onClick={() => void forceAddNow(m)}
                    >
                      仍要加入
                    </button>
                  )}
                  {m.candidates &&
                    m.candidates.ctx.items.map((item, idx) => {
                      const idx1 = idx + 1
                      const state = m.candidates!.added[idx1]
                      return (
                        <div
                          key={idx}
                          className="rounded-xl border border-slate-200 bg-surface p-3 shadow-sm"
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-slate-500">
                              {TYPE_LABELS[item.item_type]}
                            </span>
                            <span className="min-w-0 flex-1 text-sm leading-5 font-medium">{item.title}</span>
                            <ConfidenceBadge value={item.confidence} />
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                            {item.start_time && <span>开始：{fmtTime(item.start_time)}</span>}
                            {item.due_time && <span className="text-red-500">截止：{fmtTime(item.due_time)}</span>}
                            {item.location && <span>地点：{item.location}</span>}
                          </div>
                          {item.belonging_reason && (
                            <div className="mt-1 text-xs text-slate-400">{item.belonging_reason}</div>
                          )}
                          {item.duplicate_of && !state && (
                            <div className="mt-1 text-xs text-amber-600">
                              疑似重复：可能与已有任务「{item.duplicate_of}」是同一件事
                            </div>
                          )}
                          <div className="mt-2 flex items-center gap-2">
                            {state ? (
                              <span
                                className={`text-xs ${state === 'added' ? 'text-emerald-600' : 'text-slate-400'}`}
                              >
                                {state === 'added' ? '✓ 已加入日程' : '已有相同任务，未重复添加'}
                              </span>
                            ) : (
                              <>
                                <button
                                  className={`rounded-lg px-3 py-1 text-xs text-white ${
                                    item.duplicate_of
                                      ? 'bg-amber-500 hover:bg-amber-600'
                                      : 'bg-brand hover:bg-brand-dark'
                                  }`}
                                  onClick={() => void addCandidate(m.id, idx1, m.candidates!.ctx, item)}
                                >
                                  {item.duplicate_of ? '仍要加入' : '加入'}
                                </button>
                                <span className="text-[11px] text-slate-400">或直接告诉我怎么改</span>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                </div>
              </div>
            )
          )}

          {pending.length > 0 && (
            <div className="flex gap-3">
              <Avatar role="assistant" initial="纸" />
              <div className="flex max-w-[82%] min-w-0 flex-col gap-2">
                <div className="select-text rounded-2xl rounded-tl-sm bg-elevated px-4 py-2.5 text-sm leading-6">
                  我从你之前提交的内容里发现了 {pending.length} 个待确认事项：
                </div>
                {pending.map((t) => (
                  <div key={t.id} className="rounded-xl border border-slate-200 bg-surface p-3 shadow-sm">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-slate-500">
                        {TYPE_LABELS[t.itemType]}
                      </span>
                      <button
                        className="min-w-0 flex-1 text-left text-sm leading-5 font-medium hover:text-slate-900"
                        onClick={() => setDetail(t)}
                      >
                        {t.title}
                      </button>
                      <ConfidenceBadge value={t.confidence} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                      {t.startTime && <span>开始：{fmtTime(t.startTime)}</span>}
                      {t.dueTime && <span className="text-red-500">截止：{fmtTime(t.dueTime)}</span>}
                      {t.location && <span>地点：{t.location}</span>}
                    </div>
                    {t.belongingReason && <div className="mt-1 text-xs text-slate-400">{t.belongingReason}</div>}
                    {t.duplicateOf && (
                      <div className="mt-1 text-xs text-amber-600">
                        疑似重复：可能与已有任务「{t.duplicateOf}」是同一件事
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        className={`rounded-lg px-3 py-1 text-xs text-white ${
                          t.duplicateOf ? 'bg-amber-500 hover:bg-amber-600' : 'bg-brand hover:bg-brand-dark'
                        }`}
                        onClick={() => void api.updateTask(t.id, { status: joinStatus(t) })}
                      >
                        {t.duplicateOf ? '仍要加入' : '加入'}
                      </button>
                      <button
                        className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                        onClick={() => {
                          void api.updateTask(t.id, { status: 'ignored' })
                          showToast('已忽略，可在日程页底部「已忽略」区恢复')
                        }}
                      >
                        忽略
                      </button>
                      <button
                        className="ml-auto rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-slate-900"
                        onClick={() => setDetail(t)}
                      >
                        详情
                      </button>
                    </div>
                  </div>
                ))}
                {pending.length > 1 && (
                  <div className="flex gap-2">
                    <button
                      className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                      onClick={() => void joinAllPending()}
                    >
                      全部加入
                    </button>
                    <button
                      className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50"
                      onClick={() => void api.bulkTasks(pending.map((t) => t.id), 'ignored')}
                    >
                      全部忽略
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {busy && (
            <div className="flex gap-3">
              <Avatar role="assistant" initial="纸" />
              <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-sm bg-elevated px-4 py-3">
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    className="size-1.5 animate-bounce rounded-full bg-slate-400"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-slate-200 bg-surface px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          {screenSense && (
            <button
              title="扫描当前屏幕，自动提取待办"
              disabled={busy}
              onClick={() => void scanScreen()}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              扫描屏幕
            </button>
          )}
          <button
            title="截图捕获"
            disabled={busy}
            onClick={() => void screenshot()}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            截图
          </button>
          <button
            title="读取剪切板"
            disabled={busy}
            onClick={() => void api.captureClipboard()}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            剪贴板
          </button>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            rows={Math.min(5, Math.max(1, input.split('\n').length))}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send(input)
              }
            }}
            placeholder="粘贴通知提取事项，或问我日程…"
            className="max-h-36 min-w-0 flex-1 resize-none rounded-xl border border-slate-200 px-3.5 py-2 text-sm leading-6 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/5"
          />
          <button
            disabled={busy || !input.trim()}
            onClick={() => void send(input)}
            className="rounded-xl bg-brand px-4 py-2 text-sm text-white hover:bg-brand-dark disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>

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
