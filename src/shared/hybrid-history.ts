import type { ActivityEvent, ActivitySegment } from './activity-events.ts'

export type SemanticLevel = 'complete' | 'partial' | 'empty'
export type PrivacyState = 'normal' | 'private' | 'excluded' | 'own' | 'secure'

export interface SemanticContextInput {
  appName?: string | null
  bundleId?: string | null
  windowTitle?: string | null
  focusedRole?: string | null
  safeLabel?: string | null
  eventKind?: string | null
  eventSource?: string | null
  eventContinuous?: boolean
  observerHealthy?: boolean
  privacyState?: PrivacyState
}

export interface SemanticAssessment {
  semanticLevel: SemanticLevel
  score: number
  reasonCodes: string[]
  privacyState: PrivacyState
}

export interface EventEvidence {
  id: string
  occurredAtMs: number
  kind: string
  appName: string | null
  bundleId: string | null
  windowTitle: string | null
  focusedRole: string | null
  safeLabel: string | null
  semanticLevel: SemanticLevel
  semanticScore: number
  reasonCodes: string[]
  privacyState: PrivacyState
}

export interface OcrEvidence {
  id: string
  eventId: string | null
  segmentId: string | null
  occurredAtMs: number
  appName: string | null
  bundleId: string | null
  windowTitle: string | null
  semanticScore: number
  triggerReason: OcrTriggerReason
  redactionHits: string[]
  redactedText: string
}

export interface HybridActivitySegment extends ActivitySegment {
  semanticCompleteCount: number
  semanticPartialCount: number
  semanticEmptyCount: number
  ocrEvidenceCount: number
  triggerReasons: string[]
  latestOcrAtMs: number | null
}

export type OcrTriggerReason =
  | 'manual'
  | 'todo_scan'
  | 'legacy_event'
  | 'legacy_hard_fallback'
  | 'partial_high_value'
  | 'partial_retry'
  | 'empty_active'
  | 'observer_failure'
  | 'hard_fallback_incomplete'

export interface OcrTriggerInput {
  hybridEnabled: boolean
  semantic: SemanticAssessment
  nowMs: number
  active: boolean
  screenAllowed: boolean
  highValueEvent: boolean
  consecutivePartialCount: number
  observerHealthy: boolean
  observerFailureCount: number
  lastOcrAtMs: number | null
  lastOcrContextKey: string | null
  contextKey: string
  hardFallback: boolean
  manual?: boolean
  globalCooldownMs?: number
  /** 待办识别专用通道：内容型 App 前台且已到间隔。语义完整也要看一次正文，
   *  否则待办永远抽不出来——App 名和窗口标题里没有「周五下午三点交」。 */
  todoScanDue?: boolean
}

export interface OcrTriggerDecision {
  run: boolean
  reason: OcrTriggerReason | 'complete' | 'privacy_suppressed' | 'inactive' | 'screen_unavailable' | 'rate_limited'
}

const HIGH_VALUE_KINDS = new Set([
  'submit',
  'shortcut',
  'selection_changed',
  'ax_focus_changed',
  'ax_attribute_changed'
])

function clean(value: string | null | undefined, max = 160): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max)
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** Deterministic, explainable semantic coverage score. No model call is involved. */
export function assessSemanticCompleteness(input: SemanticContextInput): SemanticAssessment {
  const privacyState = input.privacyState ?? 'normal'
  if (privacyState !== 'normal') {
    return {
      semanticLevel: 'empty',
      score: 0,
      reasonCodes: [`privacy_${privacyState}`],
      privacyState
    }
  }

  const app = clean(input.appName, 80)
  const bundle = clean(input.bundleId, 160)
  const window = clean(input.windowTitle)
  const role = clean(input.focusedRole, 80)
  const label = clean(input.safeLabel)
  let score = 0
  const reasonCodes: string[] = []

  if (app || bundle) {
    score += 30
    reasonCodes.push('has_app_context')
  } else reasonCodes.push('missing_app_context')
  if (window) {
    score += 40
    reasonCodes.push('has_window_context')
  } else reasonCodes.push('missing_window_context')
  if (role) {
    score += 15
    reasonCodes.push('has_focused_role')
  } else reasonCodes.push('missing_focused_role')
  if (label) {
    score += 15
    reasonCodes.push('has_safe_label')
  } else reasonCodes.push('missing_safe_label')
  if (HIGH_VALUE_KINDS.has(input.eventKind ?? '')) {
    score += 10
    reasonCodes.push('high_value_event')
  }
  if (input.eventContinuous) reasonCodes.push('context_continuous')
  if (input.observerHealthy === false) reasonCodes.push('observer_degraded')
  if (input.eventSource === 'accessibility') reasonCodes.push('accessibility_context')
  if (input.eventSource === 'workspace') reasonCodes.push('workspace_context')

  // 没有 Accessibility 时，App/窗口标题只能作为不完整的降级语义；
  // 否则 30+40 恰好会被误判为 complete，进而跳过 OCR 和工作归类。
  const normalizedScore = clampScore(input.observerHealthy === false ? Math.min(score, 60) : score)
  const semanticLevel: SemanticLevel =
    normalizedScore >= 70 ? 'complete' : normalizedScore >= 30 ? 'partial' : 'empty'
  return { semanticLevel, score: normalizedScore, reasonCodes, privacyState }
}

export function isHighValueActivityEvent(event: Pick<ActivityEvent, 'kind'>): boolean {
  return HIGH_VALUE_KINDS.has(event.kind)
}

export function contextKey(input: Pick<SemanticContextInput, 'appName' | 'bundleId' | 'windowTitle'>): string {
  return [clean(input.appName, 80), clean(input.bundleId, 160), clean(input.windowTitle)].join('|').toLowerCase()
}

/** Hybrid v2 OCR matrix. Privacy and rate gates are absolute and deterministic. */
export function decideOcrTrigger(input: OcrTriggerInput): OcrTriggerDecision {
  if (input.manual) return { run: input.screenAllowed, reason: 'manual' }
  if (!input.hybridEnabled) {
    return {
      run: input.screenAllowed,
      reason: input.hardFallback ? 'legacy_hard_fallback' : 'legacy_event'
    }
  }
  if (input.semantic.privacyState !== 'normal') return { run: false, reason: 'privacy_suppressed' }
  if (!input.active) return { run: false, reason: 'inactive' }
  if (!input.screenAllowed) return { run: false, reason: 'screen_unavailable' }
  if (!input.observerHealthy && input.observerFailureCount > 1)
    return { run: false, reason: 'rate_limited' }

  const cooldownMs = Number.isFinite(input.globalCooldownMs) && (input.globalCooldownMs ?? 0) >= 0
    ? input.globalCooldownMs!
    : 45_000
  if (input.lastOcrAtMs != null && input.nowMs - input.lastOcrAtMs < cooldownMs)
    return { run: false, reason: 'rate_limited' }
  // 隐私/闲置/权限/限流四道门之后、语义短路之前：待办识别独立放行。
  // 放在 cooldown 之后是有意的——todo-scan 间隔（默认 180s）远大于全局冷却（45s），不冲突。
  if (input.todoScanDue) return { run: true, reason: 'todo_scan' }
  if (input.semantic.semanticLevel === 'complete') return { run: false, reason: 'complete' }

  // restartCount=0 with a healthy collector means Accessibility is simply not
  // authorized; use the normal partial/empty fallback matrix in that case.
  // A restarted/failed helper gets one explicitly labeled rescue OCR.
  if (!input.observerHealthy && input.observerFailureCount > 0 && input.observerFailureCount <= 1)
    return { run: true, reason: 'observer_failure' }
  if (input.semantic.semanticLevel === 'partial') {
    if (input.highValueEvent) return { run: true, reason: 'partial_high_value' }
    if (input.consecutivePartialCount >= 2 && input.lastOcrContextKey !== input.contextKey)
      return { run: true, reason: 'partial_retry' }
    return { run: false, reason: 'complete' }
  }
  if (input.hardFallback) return { run: true, reason: 'empty_active' }
  return { run: false, reason: 'complete' }
}

export function hybridSegmentFromActivity(
  segment: ActivitySegment,
  assessments: readonly SemanticAssessment[],
  ocrEvidence: readonly OcrEvidence[]
): HybridActivitySegment {
  const reasons = new Set<string>()
  for (const assessment of assessments) for (const reason of assessment.reasonCodes) reasons.add(reason)
  for (const evidence of ocrEvidence) reasons.add(evidence.triggerReason)
  return {
    ...segment,
    semanticCompleteCount: assessments.filter((item) => item.semanticLevel === 'complete').length,
    semanticPartialCount: assessments.filter((item) => item.semanticLevel === 'partial').length,
    semanticEmptyCount: assessments.filter((item) => item.semanticLevel === 'empty').length,
    ocrEvidenceCount: ocrEvidence.length,
    triggerReasons: [...reasons].sort(),
    latestOcrAtMs: ocrEvidence.length ? Math.max(...ocrEvidence.map((item) => item.occurredAtMs)) : null
  }
}
