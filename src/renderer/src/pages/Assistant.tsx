import { useEffect, useRef, useState } from 'react'
import type { TaskRecord } from '@shared/types'
import type { CandidateContext, ChatHistoryItem, ParsedItem } from '@shared/parsing'
import { api } from '../api'
import { fmtTime, summaryToast, TYPE_LABELS } from '../labels'
import ConfidenceBadge from '../components/ConfidenceBadge'
import TaskDetailModal from '../components/TaskDetailModal'
import SourceModal from '../components/SourceModal'
import agentAvatar from '../assets/agent-avatar.png'

interface Props {
  tasks: TaskRecord[]
  showToast: (msg: string) => void
  userName: string
}

type AddState = 'added' | 'duplicate'

interface ChatMsg {
  id: number
  role: 'user' | 'assistant'
  text: string
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

function AgentAvatar(): React.JSX.Element {
  return <img className="avatar agent" src={agentAvatar} alt="纸壳助手" />
}

function UserAvatar({ initial }: { initial: string }): React.JSX.Element {
  return (
    <div className="avatar user" style={{ background: 'var(--c4)' }}>
      {initial}
    </div>
  )
}

export default function Assistant({ tasks, showToast, userName }: Props): React.JSX.Element {
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
    return api.on('eshell:settings-updated', load)
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

  const send = async (raw: string): Promise<void> => {
    const value = raw.trim()
    if (!value || busy) return
    setInput('')
    update([...store.msgs, { id: store.nextId++, role: 'user', text: value }])
    setBusy(true)
    const ctx = activeCandidates()
    const history: ChatHistoryItem[] = store.msgs
      .filter((m) => m.text && !m.error)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.text }))
    const res = await api.assistantChat({ history, candidates: ctx })
    setBusy(false)

    if (res.error) {
      const hint = /积分|额度/.test(res.error)
        ? '（到「设置 → 账户」充值后再试）'
        : /登录/.test(res.error)
          ? '（请重新登录后再试）'
          : ''
      update([
        ...store.msgs,
        { id: store.nextId++, role: 'assistant', text: `出错了：${res.error}${hint}`, error: true }
      ])
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
    update([...store.msgs, reply, ...dupMsgs])
  }

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

  const userInitial = userName.slice(0, 1) || '我'

  return (
    <div className="chat">
      <div className="chat-scroll">
        <div className="chat-inner">
          {/* 助手问候（仅无消息时显示） */}
          {msgs.length === 0 && (
            <div className="msg">
              <AgentAvatar />
              <div className="msg-col">
                <div className="bubble agent">
                  你好，我是纸壳助手。我会自动留意你设备上的通知、消息和聊天记录，从中帮你拎出该办的事，主动提给你确认；你也可以直接问我日程安排。
                </div>
                <div className="suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 消息列表 */}
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="msg me">
                <div className="bubble me">{m.text}</div>
                <UserAvatar initial={userInitial} />
              </div>
            ) : (
              <div key={m.id} className="msg">
                <AgentAvatar />
                <div className="msg-col">
                  <div className={`bubble agent${m.error ? '' : ''}`} style={m.error ? { border: '1px solid var(--danger-line)', background: 'var(--danger-bg)', color: 'var(--danger)' } : {}}>
                    {m.text}
                  </div>
                  {m.forceAdd && !m.forceAdd.used && (
                    <div className="act">
                      <button
                        className="btn primary sm"
                        onClick={() => void forceAddNow(m)}
                      >
                        仍要加入
                      </button>
                    </div>
                  )}
                  {m.candidates &&
                    m.candidates.ctx.items.map((item, idx) => {
                      const idx1 = idx + 1
                      const state = m.candidates!.added[idx1]
                      return (
                        <div key={idx} className="cand">
                          <div className="top">
                            <span className="tag">{TYPE_LABELS[item.item_type]}</span>
                            <span className="ct">{item.title}</span>
                            <ConfidenceBadge value={item.confidence} />
                          </div>
                          <div className="det">
                            {item.start_time && <span>开始：{fmtTime(item.start_time)}</span>}
                            {item.due_time && <span className="is-danger">截止：{fmtTime(item.due_time)}</span>}
                            {item.location && <span>地点：{item.location}</span>}
                          </div>
                          {item.belonging_reason && (
                            <div className="reason">{item.belonging_reason}</div>
                          )}
                          {item.duplicate_of && !state && (
                            <div className="reason" style={{ color: 'var(--warn)' }}>
                              疑似重复：可能与已有任务「{item.duplicate_of}」是同一件事
                            </div>
                          )}
                          <div className="act">
                            {state ? (
                              <span style={{ fontSize: 12, color: state === 'added' ? 'var(--ok)' : 'var(--t3)' }}>
                                {state === 'added' ? '✓ 已加入日程' : '已有相同任务，未重复添加'}
                              </span>
                            ) : (
                              <>
                                <button
                                  className="btn primary sm"
                                  style={item.duplicate_of ? { background: 'var(--warn)' } : {}}
                                  onClick={() => void addCandidate(m.id, idx1, m.candidates!.ctx, item)}
                                >
                                  {item.duplicate_of ? '仍要加入' : '加入'}
                                </button>
                                <span className="muted-s" style={{ fontSize: 11 }}>或直接告诉我怎么改</span>
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

          {/* 待确认的 pending 任务 */}
          {pending.length > 0 && (
            <div className="msg">
              <AgentAvatar />
              <div className="msg-col">
                <div className="bubble agent">
                  我从你之前提交的内容里发现了 {pending.length} 个待确认事项：
                </div>
                {pending.map((t) => (
                  <div key={t.id} className="cand">
                    <div className="top">
                      <span className="tag">{TYPE_LABELS[t.itemType]}</span>
                      <button
                        className="ct"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                        onClick={() => setDetail(t)}
                      >
                        {t.title}
                      </button>
                      <ConfidenceBadge value={t.confidence} />
                    </div>
                    <div className="det">
                      {t.startTime && <span>开始：{fmtTime(t.startTime)}</span>}
                      {t.dueTime && <span className="is-danger">截止：{fmtTime(t.dueTime)}</span>}
                      {t.location && <span>地点：{t.location}</span>}
                    </div>
                    {t.belongingReason && <div className="reason">{t.belongingReason}</div>}
                    {t.duplicateOf && (
                      <div className="reason" style={{ color: 'var(--warn)' }}>
                        疑似重复：可能与已有任务「{t.duplicateOf}」是同一件事
                      </div>
                    )}
                    <div className="act">
                      <button
                        className="btn primary sm"
                        style={t.duplicateOf ? { background: 'var(--warn)' } : {}}
                        onClick={() => void api.updateTask(t.id, { status: joinStatus(t) })}
                      >
                        {t.duplicateOf ? '仍要加入' : '加入'}
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => {
                          void api.updateTask(t.id, { status: 'ignored' })
                          showToast('已忽略，可在日程页底部「已忽略」区恢复')
                        }}
                      >
                        忽略
                      </button>
                      <button
                        className="btn sm"
                        style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)' }}
                        onClick={() => setDetail(t)}
                      >
                        详情
                      </button>
                    </div>
                  </div>
                ))}
                {pending.length > 1 && (
                  <div className="suggest">
                    <button onClick={() => void joinAllPending()}>全部加入</button>
                    <button onClick={() => void api.bulkTasks(pending.map((t) => t.id), 'ignored')}>全部忽略</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 打字中动画 */}
          {busy && (
            <div className="msg">
              <AgentAvatar />
              <div className="bubble agent" style={{ padding: 0 }}>
                <div className="typing"><i /><i /><i /></div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* 输入栏 */}
      <div className="composer">
        <div className="composer-inner">
          {screenSense && (
            <button
              className="icon-btn"
              title="扫描当前屏幕，自动提取待办"
              disabled={busy}
              onClick={() => void scanScreen()}
            >
              <svg className="ico" viewBox="0 0 24 24">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
            </button>
          )}
          <button
            className="icon-btn"
            title="截图捕获"
            disabled={busy}
            onClick={() => void screenshot()}
          >
            <svg className="ico" viewBox="0 0 24 24">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="读取剪切板"
            disabled={busy}
            onClick={() => void api.captureClipboard()}
          >
            <svg className="ico" viewBox="0 0 24 24">
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            </svg>
          </button>
          <div className="input-pill">
            <input
              ref={textareaRef as unknown as React.RefObject<HTMLInputElement>}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send(input)
                }
              }}
              placeholder="粘贴通知让我提取事项，或直接问我日程…"
            />
            <button
              className="send"
              disabled={busy || !input.trim()}
              onClick={() => void send(input)}
            >
              <svg className="ico" viewBox="0 0 24 24">
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
              </svg>
            </button>
          </div>
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
