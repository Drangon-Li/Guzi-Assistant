import { useEffect, useRef } from 'react'
import type { ExitDecision, ExitDraft, ExitRequest, ExitResponse } from '@shared/exit-lifecycle'
import { api } from './api'

export interface ExitParticipant {
  id: string
  label: string
  isDirty: () => boolean
  prepare: (decision: ExitDecision) => Promise<void>
  canSave?: boolean
  canDiscard?: boolean
  alwaysPrepare?: boolean
}
const participants = new Map<string, ExitParticipant>()
const saves = new Set<Promise<unknown>>()
const saveErrors = new Map<string | symbol, unknown>()
let currentRequest: string | null = null
let inspected = new Map<string, ExitParticipant>()
let frozen = false

export function isExitPreparing(): boolean { return frozen }
export function clearExitSaveError(key: string): void { saveErrors.delete(key) }
export function trackExitSave<T>(promise: Promise<T>, key?: string): Promise<T> {
  const errorKey = key ?? Symbol()
  saves.add(promise)
  void promise.then(() => { saves.delete(promise); saveErrors.delete(errorKey) }, (error) => {
    saves.delete(promise)
    saveErrors.set(errorKey, error)
  })
  return promise
}
async function drainSaves(): Promise<void> {
  while (saves.size) await Promise.allSettled([...saves])
  if (saveErrors.size) {
    const [key, error] = saveErrors.entries().next().value as [string | symbol, unknown]
    if (typeof key === 'symbol') saveErrors.delete(key)
    throw error
  }
}
export function registerExitParticipant(participant: ExitParticipant): () => void {
  participants.set(participant.id, participant)
  return () => { if (participants.get(participant.id) === participant) participants.delete(participant.id) }
}
export function useExitParticipant(participant: ExitParticipant): void {
  const latest = useRef(participant)
  latest.current = participant
  useEffect(() => registerExitParticipant({
    id: participant.id,
    get label() { return latest.current.label },
    get canSave() { return latest.current.canSave },
    get canDiscard() { return latest.current.canDiscard },
    get alwaysPrepare() { return latest.current.alwaysPrepare },
    isDirty: () => latest.current.isDirty(),
    prepare: (decision) => latest.current.prepare(decision)
  }), [participant.id])
}
function freeze(value: boolean): void {
  frozen = value
  document.documentElement.style.cursor = value ? 'wait' : ''
  document.documentElement.setAttribute('aria-busy', String(value))
}
function preventInput(event: Event): void {
  if (!frozen) return
  event.preventDefault()
  event.stopImmediatePropagation()
}
export function installRendererExitLifecycle(): void {
  for (const name of ['pointerdown', 'click', 'keydown', 'beforeinput', 'drop', 'submit', 'blur', 'focusout'])
    window.addEventListener(name, preventInput, true)
  api.on('guzi-assistant:exit-request', (value) => {
    const request = value as ExitRequest
    if (request.stage === 'resume') {
      if (request.requestId === currentRequest) { freeze(false); currentRequest = null; inspected.clear() }
      return
    }
    const respond = async (): Promise<ExitResponse> => {
      if (request.stage === 'inspect') {
        currentRequest = request.requestId
        freeze(true)
        inspected = new Map(participants)
        const drafts: ExitDraft[] = []
        for (const participant of inspected.values()) {
          if (participant.isDirty()) drafts.push({ id: participant.id, label: participant.label,
            canSave: participant.canSave !== false, canDiscard: participant.canDiscard })
        }
        return { requestId: request.requestId, stage: 'inspect', drafts }
      }
      if (currentRequest !== request.requestId) throw new Error('退出请求已失效')
      for (const participant of inspected.values()) {
        const decision = request.decisions?.[participant.id]
        if (decision || participant.alwaysPrepare) await participant.prepare(decision ?? 'save')
      }
      await drainSaves()
      return { requestId: request.requestId, stage: 'prepare' }
    }
    void respond().catch((error): ExitResponse => ({ requestId: request.requestId, stage: request.stage as 'inspect' | 'prepare',
      error: error instanceof Error ? error.message : String(error) })).then((response) => api.exitResponse(response)).catch(console.error)
  })
}
