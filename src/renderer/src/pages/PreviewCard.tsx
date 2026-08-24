import { useEffect, useRef, useState } from 'react'
import type { ParseSummary, PendingCapture } from '@shared/types'
import type { ParsedItem } from '@shared/parsing'
import type { LocalExtraction } from '@shared/types'
import { api } from '../api'
import { fmtTime, SOURCE_LABELS } from '../labels'
import brandMark from '../assets/agent-avatar.png'

type State =
  | { phase: 'idle' }
  | { phase: 'preview'; capture: PendingCapture; left: number }
  | { phase: 'loading'; message?: string }
  | { phase: 'result'; summary: ParseSummary }
  | { phase: 'error'; message: string }
  | { phase: 'empty'; message: string }
  | { phase: 'suggestion'; item: ParsedItem; sourceText: string; hits: string[] }
  | { phase: 'local'; local: BatchItem }
  | { phase: 'batch'; items: BatchItem[] }
  | { phase: 'done'; message: string }

/** 清单卡上的一条候选（一屏识别出多条待办时用） */
type BatchItem = LocalExtraction & {
  item: ParsedItem
  sourceText: string
  detectionId?: string
  /** 剪贴板来源的卡不自动忽略——用户刚主动复制，不该 5 秒就当他拒绝了 */
  noAutoHide?: boolean
}

const AUTO_SECONDS = 3

/** 清单卡默认勾选：解出了具体时间、且不是明确别人的事 → 预勾。
 *  没时间的条目也列出来，但要用户自己勾——它们是靠同批里的强信号才被带出来的。 */
const pickedByDefault = (item: BatchItem): boolean =>
  item.item.belongs_to_user !== 'no' && !!item.isoTime

export default function PreviewCard(): React.JSX.Element | null {
  const [state, setState] = useState<State>({ phase: 'idle' })
  // 解析期间用户再次触发快捷键时，旧提交的结果不能覆盖新预览
  const submitIdRef = useRef('')
  const [closing, setClosing] = useState(false)
  // 每次新弹出时 +1，作为外层动画 div 的 key：只在卡片「出现」时滑入一次；
  // 内部状态变化（preview→loading→result）共用同一 key，原地更新、不重放滑入
  const [seq, setSeq] = useState(0)
  // 检测卡/AI 建议卡闲置自动隐藏秒数（设置里可调；0=不自动隐藏）
  const [autoHideSec, setAutoHideSec] = useState(60)
  // 桌宠模式：卡片贴在桌宠旁，隐藏顶部冗余的「谷子助手」品牌行（桌宠已在旁边）
  const [petMode, setPetMode] = useState(false)
  // 检测卡「备注」：快速反馈（不是我的/已完成/自由输入），存档并注入后续提示词帮模型学习
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  // 检测卡/建议卡倒计时自动忽略：进度条走满 = 拒绝（检测精度有限，沉默即否）；悬停/填备注时暂停
  const [hovering, setHovering] = useState(false)
  const [remainMs, setRemainMs] = useState<number | null>(null)
  // 清单卡勾选集：按下标记，不按标题——清单里出现同名条目时按标题会让两条互相勾连
  const [picked, setPicked] = useState<Set<number>>(new Set())

  // 关闭前先播放淡出动画，再执行真正的隐藏 */
  const fadeOut = (action: () => void): void => {
    setClosing(true)
    window.setTimeout(() => {
      setClosing(false)
      setState({ phase: 'idle' })
      action()
    }, 250)
  }

  // 多卡队列切到下一张时收起备注输入
  const localDetectionId = state.phase === 'local' ? state.local.detectionId : null
  useEffect(() => {
    setNoteOpen(false)
    setNoteText('')
  }, [localDetectionId])

  const submitNote = (text: string): void => {
    const note = text.trim()
    if (!note || state.phase !== 'local') return
    void api.noteDetection({
      detectionId: state.local.detectionId ?? null,
      title: state.local.title,
      note
    })
    fadeOut(() => void api.previewHide())
  }

  const submit = async (capture: PendingCapture): Promise<void> => {
    submitIdRef.current = capture.captureId
    setState({ phase: 'loading' })
    let summary: ParseSummary
    try {
      summary = await api.previewSubmit(capture.captureId)
    } catch (e) {
      summary = {
        sourceId: '',
        total: 0,
        related: 0,
        autoAdded: 0,
        duplicates: 0,
        error: e instanceof Error ? e.message : String(e)
      }
    }
    if (submitIdRef.current !== capture.captureId) return
    if (summary.error) setState({ phase: 'error', message: summary.error })
    else setState({ phase: 'result', summary })
  }

  const close = (): void => fadeOut(() => void api.previewHide())

  const toggle = (index: number): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  // 清单卡 →「加入选中」：勾选的逐条入库（主进程复用单条的查重路径）
  const acceptBatch = async (): Promise<void> => {
    if (state.phase !== 'batch') return
    const entries = state.items
      .filter((_, index) => picked.has(index))
      .map(({ item, sourceText, detectionId }) => ({ item, sourceText, detectionId }))
    if (!entries.length) return
    setState({ phase: 'loading', message: '正在加入…' })
    try {
      const r = await api.acceptLocalBatch({ entries })
      setState({
        phase: 'done',
        message: r.duplicates
          ? `✓ 已加入 ${r.added} 条（${r.duplicates} 条重复已跳过）`
          : `✓ 已加入 ${r.added} 条`
      })
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  // 忽略整份清单：全部标 dismissed，之后同内容不再重复弹（与单卡 ✕ 同语义）
  const dismissBatch = (): void => {
    if (state.phase !== 'batch') return
    const ids = state.items.map((item) => item.detectionId).filter((id): id is string => !!id)
    fadeOut(() => {
      for (const id of ids) void api.dismissDetection(id)
      void api.previewHide()
    })
  }

  // 检测候选 →「同意」：直接入库（已是云端解析结果）
  const acceptLocalNow = async (): Promise<void> => {
    if (state.phase !== 'local') return
    const { item, sourceText, detectionId } = state.local
    setState({ phase: 'loading', message: '正在加入…' })
    try {
      const info = await api.acceptLocal({ item, sourceText, detectionId })
      setState({
        phase: 'done',
        message: info.duplicate ? `「${info.title}」已存在，未重复添加` : `✓ 已加入「${info.title}」`
      })
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const acceptSuggestion = async (modify: boolean): Promise<void> => {
    if (state.phase !== 'suggestion') return
    const { item, sourceText } = state
    setState({ phase: 'loading', message: '正在加入…' })
    try {
      const info = await api.suggestionAccept({ item, sourceText })
      if (modify) {
        void api.focusMain('schedule')
        close() // 关掉预览卡（淡出→previewHide），主进程据此推进多任务队列
      } else if (info.duplicate) {
        setState({ phase: 'done', message: `「${info.title}」与已有任务相同，未重复添加` })
      } else {
        setState({ phase: 'done', message: `✓ 已加入「${info.title}」` })
      }
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  useEffect(() => {
    return api.on('guzi-assistant:preview', (payload) => {
      const p = payload as
        | (PendingCapture & { error?: undefined; busy?: undefined; summary?: undefined; suggestion?: undefined })
        | { error: string; busy?: undefined; summary?: undefined; suggestion?: undefined }
        | { busy: string; error?: undefined; summary?: undefined; suggestion?: undefined }
        | { summary: ParseSummary; error?: undefined; busy?: undefined; suggestion?: undefined }
        | {
            suggestion: { item: ParsedItem; sourceText: string; hits: string[] }
            error?: undefined
            busy?: undefined
            summary?: undefined
          }
      submitIdRef.current = ''
      setClosing(false)
      setSeq((n) => n + 1)
      setPetMode(!!(payload as { petMode?: boolean }).petMode)
      const batch = (payload as { localBatch?: { items: BatchItem[] } }).localBatch
      if (batch?.items.length) {
        setState({ phase: 'batch', items: batch.items })
        setPicked(new Set(batch.items.map((item, index) => (pickedByDefault(item) ? index : -1)).filter((i) => i >= 0)))
        return
      }
      const ls = (payload as { localSuggestion?: BatchItem }).localSuggestion
      if (ls) {
        setState({ phase: 'local', local: ls })
        return
      }
      if ('suggestion' in p && p.suggestion) {
        setState({ phase: 'suggestion', ...p.suggestion })
      } else if (p.busy) {
        // 托盘拖拽 / 右键快速操作：主进程直接驱动进度与结果
        setState({ phase: 'loading', message: p.busy })
      } else if (p.summary) {
        if (p.summary.error) setState({ phase: 'error', message: p.summary.error })
        else setState({ phase: 'result', summary: p.summary })
      } else if ('error' in p && p.error) {
        setState({ phase: 'empty', message: p.error })
      } else {
        const capture = p as PendingCapture
        // 敏感内容（CAP-07）和图片/文件（内容外发前用户应过目）都不自动提交
        setState({
          phase: 'preview',
          capture,
          left: capture.sensitiveHits.length || capture.kind !== 'text' ? -1 : AUTO_SECONDS
        })
      }
    })
  }, [])

  // 自动隐藏秒数随设置实时更新
  useEffect(() => {
    const load = (): void =>
      void api.getSettings().then((s) => setAutoHideSec(s.screenSenseCardHideSec))
    load()
    return api.on('guzi-assistant:settings-updated', load)
  }, [])

  useEffect(() => {
    if (state.phase === 'preview' && state.left >= 0) {
      if (state.left === 0) {
        void submit(state.capture)
        return
      }
      const t = window.setTimeout(
        () => setState((s) => (s.phase === 'preview' ? { ...s, left: s.left - 1 } : s)),
        1000
      )
      return () => window.clearTimeout(t)
    }
    if (
      state.phase === 'empty' ||
      state.phase === 'done' ||
      (state.phase === 'result' && state.summary.related === 0)
    ) {
      const t = window.setTimeout(close, state.phase === 'done' ? 1800 : 3000)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [state, autoHideSec])

  // 新检测卡/建议卡弹出：重置自动忽略倒计时。清单卡和剪贴板卡不倒计时
  useEffect(() => {
    const noAutoHide = state.phase === 'local' && state.local.noAutoHide
    if ((state.phase === 'local' || state.phase === 'suggestion') && autoHideSec > 0 && !noAutoHide)
      setRemainMs(autoHideSec * 1000)
    else setRemainMs(null)
  }, [seq, state.phase, autoHideSec, state])

  // 倒计时步进 + 走满自动忽略（= 拒绝：标记 dismissed，之后同内容不再重复弹）
  const countdownPaused = hovering || noteOpen || closing
  useEffect(() => {
    if (remainMs === null || countdownPaused) return undefined
    if (remainMs <= 0) {
      setRemainMs(null)
      fadeOut(() => {
        if (state.phase === 'local' && state.local.detectionId)
          void api.dismissDetection(state.local.detectionId)
        void api.previewHide()
      })
      return undefined
    }
    const t = window.setTimeout(() => setRemainMs((m) => (m === null ? null : m - 100)), 100)
    return () => window.clearTimeout(t)
  }, [remainMs, countdownPaused, state])

  if (state.phase === 'idle') return null
  // 桌宠模式下：扫描/解析的 loading 由桌宠 Siri 光环表达，不弹空卡
  if (state.phase === 'loading' && petMode) return null

  return (
    <div className="flex h-screen items-end justify-end overflow-hidden p-2">
      <div
        key={seq}
        className={`${closing ? 'animate-card-out' : 'animate-card-in'} relative flex w-full flex-col gap-2.5 overflow-hidden rounded-2xl border border-slate-200 bg-surface p-4 text-sm shadow-2xl`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div className="flex items-center gap-2">
          {!petMode && (
            <>
              <img src={brandMark} alt="" className="size-4 shrink-0" />
              <span className="text-xs font-medium text-slate-500">谷子助手</span>
            </>
          )}
          {state.phase === 'preview' && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
              {SOURCE_LABELS[state.capture.type]}
            </span>
          )}
          <button
            className="ml-auto -mr-1 px-1 text-slate-400 hover:text-slate-600"
            onClick={() =>
              fadeOut(() => {
                if (state.phase === 'preview') void api.previewCancel(state.capture.captureId)
                else {
                  // 拒绝本地检测：标记已忽略，之后同内容不再重复弹（修「拒绝后仍重复抓取」）
                  if (state.phase === 'local' && state.local.detectionId)
                    void api.dismissDetection(state.local.detectionId)
                  if (state.phase === 'batch')
                    for (const item of state.items)
                      if (item.detectionId) void api.dismissDetection(item.detectionId)
                  void api.previewHide()
                }
              })
            }
          >
            ✕
          </button>
        </div>

        {state.phase === 'preview' && (
          <>
            {state.capture.thumbnailDataUrl ? (
              <img
                src={state.capture.thumbnailDataUrl}
                alt="剪切板图片预览"
                className="max-h-24 self-start rounded-lg border border-slate-200 object-contain"
              />
            ) : (
              <div className="line-clamp-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                {state.capture.excerpt}
              </div>
            )}
            <div className="text-[11px] text-slate-400">
              {state.capture.kind === 'text' && `${state.capture.charCount} 字`}
              {state.capture.fileName && state.capture.fileName}
              {state.capture.kind !== 'text' && !state.capture.sensitiveHits.length && (
                <span className="ml-1">图片/文件不会自动提交，请确认后发送</span>
              )}
            </div>
            {state.capture.sensitiveHits.length > 0 && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                内容疑似包含：{state.capture.sensitiveHits.join('、')}。请确认后再提交。
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                onClick={() => {
                  const id = state.capture.captureId
                  fadeOut(() => void api.previewCancel(id))
                }}
              >
                取消
              </button>
              <button
                className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark"
                onClick={() => void submit(state.capture)}
              >
                {state.left >= 0 ? `提交解析（${state.left}s）` : '确认提交'}
              </button>
            </div>
          </>
        )}

        {state.phase === 'loading' && (
          <div className="flex items-center gap-2 py-3 text-xs text-slate-500">
            <span className="size-3 animate-spin rounded-full border-2 border-slate-700 border-t-transparent" />
            {state.message ?? '谷子助手正在解析…'}
          </div>
        )}

        {state.phase === 'result' && (
          <>
            <div className="text-sm leading-6">
              {state.summary.related > 0 ? (
                <>
                  发现 <span className="font-semibold text-slate-900">{state.summary.related}</span>{' '}
                  个可能与你有关的事项
                  {state.summary.autoAdded > 0 && (
                    <span className="text-xs text-slate-400">
                      （{state.summary.autoAdded} 个已自动加入日程）
                    </span>
                  )}
                </>
              ) : (
                <span className="text-slate-500">
                  {state.summary.duplicates
                    ? `内容与已有任务重复，已跳过 ${state.summary.duplicates} 个`
                    : '未发现与你相关的事项'}
                </span>
              )}
              {state.summary.related > 0 && state.summary.duplicates > 0 && (
                <span className="text-xs text-slate-400">
                  （另跳过 {state.summary.duplicates} 个重复任务）
                </span>
              )}
            </div>
            {state.summary.related > 0 && (
              <div className="flex justify-end gap-2">
                <button
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                  onClick={close}
                >
                  关闭
                </button>
                <button
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark"
                  onClick={() => {
                    void api.focusMain('assistant')
                    setState({ phase: 'idle' })
                  }}
                >
                  去确认
                </button>
              </div>
            )}
          </>
        )}

        {state.phase === 'error' && (
          <>
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">
              {state.message}
            </div>
            <div className="flex justify-end">
              <button
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                onClick={close}
              >
                关闭
              </button>
            </div>
          </>
        )}

        {state.phase === 'empty' && <div className="py-1 text-xs text-slate-500">{state.message}</div>}

        {state.phase === 'suggestion' && (
          <>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600">
                AI 已解析
              </span>
              <span className="min-w-0 flex-1 text-sm leading-5 font-medium">{state.item.title}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-xs text-slate-500">
              {state.item.start_time && <span>开始 {fmtTime(state.item.start_time)}</span>}
              {state.item.due_time && (
                <span className="text-red-500">截止 {fmtTime(state.item.due_time)}</span>
              )}
              {state.item.location && <span>{state.item.location}</span>}
            </div>
            {/* 不设「拒绝」：倒计时走满自动忽略，右上 ✕ 可立即关。用户只需在想要时点「同意」 */}
            <div className="flex justify-end gap-2">
              <button
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                onClick={() => void acceptSuggestion(true)}
              >
                修改
              </button>
              <button
                className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark"
                onClick={() => void acceptSuggestion(false)}
              >
                同意
              </button>
            </div>
          </>
        )}

        {state.phase === 'local' && (
          <>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                检测到日程
              </span>
              <span className="min-w-0 flex-1 text-sm leading-5 font-medium">
                {state.local.title}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {state.local.isoTime ? fmtTime(state.local.isoTime) : '未识别到具体时间'}
            </div>
            {noteOpen && (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-1">
                  {['不是我的日程', '已经完成了', '时间不对'].map((t) => (
                    <button
                      key={t}
                      className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-brand-soft hover:text-brand"
                      onClick={() => submitNote(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs focus:border-slate-400 focus:outline-none"
                    placeholder="补充一句，帮我下次判断得更准…"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitNote(noteText)
                    }}
                  />
                  <button
                    className="shrink-0 rounded-md bg-brand px-2.5 py-1 text-[11px] text-white hover:bg-brand-dark disabled:opacity-40"
                    disabled={!noteText.trim()}
                    onClick={() => submitNote(noteText)}
                  >
                    发送
                  </button>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="mr-auto rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                onClick={() => setNoteOpen(!noteOpen)}
              >
                {noteOpen ? '收起' : '备注'}
              </button>
              {/* 不设「拒绝」：倒计时走满自动忽略（等同拒绝），右上 ✕ 可立即忽略 */}
              <button
                className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark"
                onClick={() => void acceptLocalNow()}
              >
                同意
              </button>
            </div>
          </>
        )}

        {state.phase === 'batch' && (
          <>
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                识别到清单
              </span>
              <span className="text-xs text-slate-500">共 {state.items.length} 条，勾选后一次加入</span>
            </div>
            <ul className="-mx-1 max-h-52 overflow-y-auto">
              {state.items.map((item, index) => (
                <li key={index}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 shrink-0 accent-brand"
                      checked={picked.has(index)}
                      onChange={() => toggle(index)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs leading-5">{item.title}</span>
                      <span className="block text-[11px] text-slate-400">
                        {item.isoTime ? fmtTime(item.isoTime) : '未识别到具体时间'}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                className="mr-auto rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                onClick={dismissBatch}
              >
                全部忽略
              </button>
              <button
                className="rounded-lg bg-brand px-3 py-1.5 text-xs text-white hover:bg-brand-dark disabled:opacity-40"
                disabled={picked.size === 0}
                onClick={() => void acceptBatch()}
              >
                加入选中的 {picked.size} 条
              </button>
            </div>
          </>
        )}

        {/* 自动忽略倒计时：进度条与卡片底边框融合（贴最底、横贯全宽、随圆角裁切），
            涨满 = 拒绝收起；悬停或填备注时暂停（暂停时条变淡示意） */}
        {remainMs !== null && (state.phase === 'local' || state.phase === 'suggestion') && (
          <div
            aria-hidden="true"
            className={`absolute bottom-0 left-0 h-[3px] bg-brand transition-[width,opacity] duration-100 ease-linear ${
              countdownPaused ? 'opacity-25' : 'opacity-60'
            }`}
            style={{ width: `${Math.min(100, (1 - remainMs / (autoHideSec * 1000)) * 100)}%` }}
          />
        )}

        {state.phase === 'done' && (
          <div className="py-1 text-xs text-emerald-600">{state.message}</div>
        )}
      </div>
    </div>
  )
}
