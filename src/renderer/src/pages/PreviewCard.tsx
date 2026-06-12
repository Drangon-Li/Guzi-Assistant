import { useEffect, useRef, useState } from 'react'
import type { ParseSummary, PendingCapture } from '@shared/types'
import { api } from '../api'
import { SOURCE_LABELS } from '../labels'

type State =
  | { phase: 'idle' }
  | { phase: 'preview'; capture: PendingCapture; left: number }
  | { phase: 'loading'; message?: string }
  | { phase: 'result'; summary: ParseSummary }
  | { phase: 'error'; message: string }
  | { phase: 'empty'; message: string }

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
    if (summary.error) setState({ phase: 'error', message: summary.error })
    else setState({ phase: 'result', summary })
  }

  const close = (): void => {
    void api.previewHide()
    setState({ phase: 'idle' })
  }

  useEffect(() => {
    return api.on('al1:preview', (payload) => {
      const p = payload as
        | (PendingCapture & { error?: undefined; busy?: undefined; summary?: undefined })
        | { error: string; busy?: undefined; summary?: undefined }
        | { busy: string; error?: undefined; summary?: undefined }
        | { summary: ParseSummary; error?: undefined; busy?: undefined }
      submitIdRef.current = ''
      if (p.busy) {
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
    if (state.phase === 'empty' || (state.phase === 'result' && state.summary.related === 0)) {
      const t = window.setTimeout(close, 3000)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [state])

  if (state.phase === 'idle') return null

  return (
    <div className="flex h-screen items-end justify-end p-2">
      <div
        key={state.phase}
        className="animate-card-in flex w-full flex-col gap-2.5 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-2xl"
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold">al1</span>
          {state.phase === 'preview' && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
              {SOURCE_LABELS[state.capture.type]}
            </span>
          )}
          <button
            className="ml-auto -mr-1 px-1 text-slate-400 hover:text-slate-600"
            onClick={() => {
              if (state.phase === 'preview') void api.previewCancel(state.capture.captureId)
              else void api.previewHide()
              setState({ phase: 'idle' })
            }}
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
                  void api.previewCancel(state.capture.captureId)
                  setState({ phase: 'idle' })
                }}
              >
                取消
              </button>
              <button
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700"
                onClick={() => void submit(state.capture)}
              >
                {state.left >= 0 ? `提交解析（${state.left}s）` : '确认提交'}
              </button>
            </div>
          </>
        )}

        {state.phase === 'loading' && (
          <div className="flex items-center gap-2 py-3 text-xs text-slate-500">
            <span className="size-3 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
            {state.message ?? 'al1 正在解析…'}
          </div>
        )}

        {state.phase === 'result' && (
          <>
            <div className="text-sm leading-6">
              {state.summary.related > 0 ? (
                <>
                  发现 <span className="font-semibold text-indigo-600">{state.summary.related}</span>{' '}
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
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700"
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
      </div>
    </div>
  )
}
