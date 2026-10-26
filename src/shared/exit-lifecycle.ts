export type ExitReason = 'quit' | 'restart' | 'install-update'
export type ExitDecision = 'save' | 'discard'
export interface ExitDraft {
  id: string
  label: string
  canSave: boolean
  canDiscard?: boolean
}
export interface ExitRequest {
  requestId: string
  stage: 'inspect' | 'prepare' | 'resume'
  reason: ExitReason
  decisions?: Record<string, ExitDecision>
}
export interface ExitResponse {
  requestId: string
  stage: 'inspect' | 'prepare'
  drafts?: ExitDraft[]
  error?: string
}
export type ExitResult = { status: 'committed' } | { status: 'cancelled' } | { status: 'failed'; message: string }
