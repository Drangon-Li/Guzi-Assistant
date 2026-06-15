import { useEffect, useRef, useState } from 'react'
import type { ParseSummary, PendingCapture } from '@shared/types'
import type { ParsedItem } from '@shared/parsing'
import { api } from '../api'
import { fmtTime, SOURCE_LABELS } from '../labels'

type State =
  | { phase: 'idle' }
  | { phase: 'preview'; capture: PendingCapture; left: number }
  | { phase: 'loading'; message?: string }
  | { phase: 'result'; summary: ParseSummary }
  | { phase: 'error'; message: string; errorCode?: '401' | '402' | '502' | null }
  | { phase: 'empty'; message: string }
  | { phase: 'suggestion'; item: ParsedItem; sourceText: string; hits: string[] }
  | { phase: 'done'; message: string }

const AUTO_SECONDS = 3

export default function PreviewCard(): React.JSX.Element | null {
  const [state, setState] = useState<State>({ phase: 'idle' })
  // 解析期间用户再次触发快捷键时，旧提交的结果不能覆盖新预览
  const submitIdRef = useRef('')

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
    if (summary.error)
      setState({ phase: 'error', message: summary.error, errorCode: summary.errorCode })
    else setState({ phase: 'result', summary })
  }

  const close = (): void => {
    void api.previewHide()
    setState({ phase: 'idle' })
  }

  const acceptSuggestion = async (modify: boolean): Promise<void> => {
    if (state.phase !== 'suggestion') return
    const { item, sourceText } = state
    setState({ phase: 'loading', message: '正在加入…' })
    try {
      const info = await api.suggestionAccept({ item, sourceText })
      if (modify) {
        void api.focusMain('schedule')
        setState({ phase: 'idle' })
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
    return api.on('eshell:preview', (payload) => {
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
      if ('suggestion' in p && p.suggestion) {
        setState({ phase: 'suggestion', ...p.suggestion })
      } else if (p.busy) {
        // 托盘拖拽 / 右键快速操作：主进程直接驱动进度与结果
        setState({ phase: 'loading', message: p.busy })
      } else if (p.summary) {
        if (p.summary.error)
          setState({ phase: 'error', message: p.summary.error, errorCode: p.summary.errorCode })
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
  }, [state])

  if (state.phase === 'idle') return null

  return (
    <div className="flex h-screen items-end justify-end p-2">
      <div key={state.phase} className="animate-card-in preview-win">
        {/* Header row */}
        <div className="ph">
          <span className="nm">EShell</span>
          {state.phase === 'preview' && (
            <span className="tag">{SOURCE_LABELS[state.capture.type]}</span>
          )}
          <button
            className="x"
            onClick={() => {
              if (state.phase === 'preview') void api.previewCancel(state.capture.captureId)
              else void api.previewHide()
              setState({ phase: 'idle' })
            }}
          >
            ✕
          </button>
        </div>

        {/* preview phase */}
        {state.phase === 'preview' && (
          <>
            {state.capture.thumbnailDataUrl ? (
              <img
                src={state.capture.thumbnailDataUrl}
                alt="剪切板图片预览"
                style={{ maxHeight: 96, alignSelf: 'flex-start', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', objectFit: 'contain' }}
              />
            ) : (
              <div className="excerpt">{state.capture.excerpt}</div>
            )}
            <div className="time">
              {state.capture.kind === 'text' && `${state.capture.charCount} 字`}
              {state.capture.fileName && state.capture.fileName}
              {state.capture.kind !== 'text' && !state.capture.sensitiveHits.length && (
                <span style={{ marginLeft: 4 }}>图片/文件不会自动提交，请确认后发送</span>
              )}
            </div>
            {state.capture.sensitiveHits.length > 0 && (
              <div className="note-amber">
                内容疑似包含：{state.capture.sensitiveHits.join('、')}。请确认后再提交。
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                className="btn ghost sm"
                onClick={() => {
                  void api.previewCancel(state.capture.captureId)
                  setState({ phase: 'idle' })
                }}
              >
                取消
              </button>
              <button
                className="btn primary sm"
                onClick={() => void submit(state.capture)}
              >
                {state.left >= 0 ? `提交解析（${state.left}s）` : '确认提交'}
              </button>
            </div>
          </>
        )}

        {/* loading phase */}
        {state.phase === 'loading' && (
          <div className="typing">
            <i /><i /><i />
            <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--t3)' }}>
              {state.message ?? '纸壳助手正在解析…'}
            </span>
          </div>
        )}

        {/* result phase */}
        {state.phase === 'result' && (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--t1)' }}>
              {state.summary.related > 0 ? (
                <>
                  发现 <strong>{state.summary.related}</strong> 个可能与你有关的事项
                  {state.summary.autoAdded > 0 && (
                    <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>
                      （{state.summary.autoAdded} 个已自动加入日程）
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: 'var(--t3)' }}>
                  {state.summary.duplicates
                    ? `内容与已有任务重复，已跳过 ${state.summary.duplicates} 个`
                    : '未发现与你相关的事项'}
                </span>
              )}
              {state.summary.related > 0 && state.summary.duplicates > 0 && (
                <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>
                  （另跳过 {state.summary.duplicates} 个重复任务）
                </span>
              )}
            </div>
            {state.summary.related > 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn ghost sm" onClick={close}>
                  关闭
                </button>
                <button
                  className="btn primary sm"
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

        {/* error phase */}
        {state.phase === 'error' && (
          <>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, transparent)', borderRadius: 'var(--r-sm)', padding: '8px 11px' }}>
              {state.message}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn ghost sm" onClick={close}>
                关闭
              </button>
              {(state.errorCode === '401' || state.errorCode === '402') && (
                <button
                  className="btn primary sm"
                  onClick={() => {
                    void api.focusMain('settings')
                    close()
                  }}
                >
                  {state.errorCode === '402' ? '去充值' : '去登录'}
                </button>
              )}
            </div>
          </>
        )}

        {/* empty phase */}
        {state.phase === 'empty' && (
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>{state.message}</div>
        )}

        {/* suggestion phase */}
        {state.phase === 'suggestion' && (
          <div className="cand">
            <div className="top">
              <span className="tag">屏幕识别</span>
              <span className="ct">{state.item.title}</span>
            </div>
            {(state.item.start_time || state.item.due_time || state.item.location) && (
              <div className="det">
                {state.item.start_time && (
                  <span className="time">开始：{fmtTime(state.item.start_time)}</span>
                )}
                {state.item.due_time && (
                  <span className="time" style={{ color: 'var(--danger)' }}>截止：{fmtTime(state.item.due_time)}</span>
                )}
                {state.item.location && (
                  <span className="time">地点：{state.item.location}</span>
                )}
              </div>
            )}
            {state.item.belonging_reason && (
              <div className="reason">{state.item.belonging_reason}</div>
            )}
            {state.hits.length > 0 && (
              <div className="reason">命中：{state.hits.join('、')}</div>
            )}
            <div className="act">
              <button
                className="btn ghost sm"
                onClick={() => {
                  void api.previewHide()
                  setState({ phase: 'idle' })
                }}
              >
                拒绝
              </button>
              <button
                className="btn outline sm"
                onClick={() => void acceptSuggestion(true)}
              >
                修改
              </button>
              <button
                className="btn primary sm"
                onClick={() => void acceptSuggestion(false)}
              >
                同意
              </button>
            </div>
          </div>
        )}

        {/* done phase */}
        {state.phase === 'done' && (
          <div style={{ fontSize: 12, color: 'var(--ok)' }}>{state.message}</div>
        )}
      </div>
    </div>
  )
}
