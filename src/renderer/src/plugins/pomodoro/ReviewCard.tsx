// 一轮结束后的复盘卡：谷子助手写一小段，用户决定保留还是丢弃。
//
// 默认**不保存**——这一轮可能只是去查了个资料，用户不想让它留在记录里就该能直接扔掉。
// 生成失败（没开屏幕感知、模型报错）也照实说，不拿一段编造的空话糊弄。
import { useEffect, useState } from 'react'
import { INTERRUPTION_LABEL, interruptionLevel, type RoundEvidence } from '@shared/pomodoro-review'
import { focusLabel } from '@shared/pomodoro'
import { api } from '../../api'

interface ReviewResult {
  ok: boolean
  review?: string
  evidence?: RoundEvidence
  error?: string
}

export default function ReviewCard({
  sessionId,
  onDone
}: {
  sessionId: string
  onDone: (kept: boolean) => void
}): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [review, setReview] = useState('')
  const [evidence, setEvidence] = useState<RoundEvidence | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void api.plugin<ReviewResult>('pomodoro', 'review', sessionId).then((res) => {
      if (!alive) return
      if (res.ok && res.review) {
        setReview(res.review)
        setEvidence(res.evidence ?? null)
        setState('ready')
      } else {
        setError(res.error ?? '没能生成')
        setState('failed')
      }
    })
    return () => {
      alive = false
    }
  }, [sessionId])

  const keep = async (): Promise<void> => {
    await api.plugin('pomodoro', 'save-review', sessionId, review)
    onDone(true)
  }

  if (state === 'loading') {
    return (
      <div className="mb-5 flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-5 py-4 text-sm text-slate-400 shadow-sm">
        <span className="size-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
        谷子助手正在回看这一轮…
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-surface px-5 py-3 text-sm text-slate-400 shadow-sm">
        <span>这一轮没写成复盘：{error}</span>
        <button onClick={() => onDone(false)} className="shrink-0 text-xs text-slate-400 hover:text-slate-600">
          知道了
        </button>
      </div>
    )
  }

  const level = evidence ? interruptionLevel(evidence) : null

  return (
    <div className="mb-5 rounded-xl border border-brand/30 bg-brand-soft/40 px-5 py-4 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-brand">这一轮的复盘</span>
        {evidence && (
          <span className="text-[11px] text-slate-400 tabular-nums">
            实际投入 {focusLabel(evidence.actualMinutes)} · 切换 {evidence.switchCount} 次
            {level ? ` · ${INTERRUPTION_LABEL[level]}` : ''}
          </span>
        )}
      </div>

      <textarea
        value={review}
        onChange={(e) => setReview(e.target.value)}
        rows={4}
        className="w-full resize-none rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand"
      />

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">保留前可以直接改；丢弃就什么都不记。</span>
        <div className="flex gap-2">
          <button
            onClick={() => onDone(false)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:border-slate-300"
          >
            丢弃
          </button>
          <button
            onClick={() => void keep()}
            disabled={!review.trim()}
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            保留
          </button>
        </div>
      </div>
    </div>
  )
}
