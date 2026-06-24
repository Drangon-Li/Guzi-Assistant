// 桌宠控制器：EShell 事件层驱动桌宠的唯一调用面。包 pet-window + 气泡仲裁器。
// 移植/精简自 openpets default-pet-controller.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
import {
  hidePet,
  isPetVisible,
  resetPetPosition,
  setPetBubble,
  setPetPaused,
  setPetReactionState,
  setPetScale,
  showPet
} from './pet-window'
import { PetBubbleArbiter, type BubblePriority } from './bubble-arbiter'
import {
  defaultPetSprite,
  resolveReactionSpriteState,
  type PetReaction,
  type UserSelectableAnimationState
} from './reaction-mapping'
import { pickReactionMessage } from './reaction-messages'
import { getPetPrefs, savePetPrefs, type PetScaleValue } from './state'

let arbiter: PetBubbleArbiter | null = null
let lastReaction: PetReaction = 'idle'
let revertTimer: ReturnType<typeof setTimeout> | null = null

function getArbiter(): PetBubbleArbiter {
  if (!arbiter) {
    arbiter = new PetBubbleArbiter({
      present: (slot, content) => {
        if (slot !== 'transient') return
        setPetBubble(content ? (content.bubble.text ?? null) : null, lastReaction)
      }
    })
  }
  return arbiter
}

function spriteIterations(reaction: PetReaction): number | 'infinite' {
  const sprite = resolveReactionSpriteState(reaction, getPetPrefs().reactionOverrides)
  return defaultPetSprite.states[sprite].iterations ?? 'infinite'
}
function spriteDurationMs(reaction: PetReaction): number {
  const sprite = resolveReactionSpriteState(reaction, getPetPrefs().reactionOverrides)
  return defaultPetSprite.states[sprite].durationMs
}

/** 播放一个 reaction 动画；有限次数动画播完自动回 idle；可附带一句自动台词。 */
export function applyExternalPetReaction(reaction: PetReaction, opts: { showMessage?: boolean } = {}): void {
  lastReaction = reaction
  setPetReactionState(reaction)
  if (revertTimer) {
    clearTimeout(revertTimer)
    revertTimer = null
  }
  const iter = spriteIterations(reaction)
  if (reaction !== 'idle' && typeof iter === 'number') {
    const ms = spriteDurationMs(reaction) * iter + 200
    revertTimer = setTimeout(() => {
      lastReaction = 'idle'
      setPetReactionState('idle')
    }, ms)
    revertTimer.unref?.()
  }
  if (opts.showMessage !== false) applyExternalPetSay(pickReactionMessage(reaction))
}

/** 显示一句气泡（经仲裁器定时清除）。可同时切换 reaction。 */
export function applyExternalPetSay(
  message: string,
  reaction?: PetReaction,
  opts: { priority?: BubblePriority; durationMs?: number } = {}
): void {
  if (reaction) {
    lastReaction = reaction
    setPetReactionState(reaction)
  }
  getArbiter().show(
    'event',
    { text: message, priority: opts.priority ?? 'normal', durationMs: opts.durationMs ?? 4200 },
    { onDismiss: () => {} }
  )
}

export function setPetPausedState(paused: boolean): void {
  savePetPrefs({ paused })
  setPetPaused(paused)
}

export function getPetPausedState(): boolean {
  return getPetPrefs().paused
}

export function setPetScaleValue(scale: PetScaleValue): void {
  setPetScale(scale)
}

/** 改某个 reaction 的动画覆盖：存偏好并即时重放当前 reaction（覆盖在运行时解析，无需重载）。 */
export function setPetReactionOverride(reaction: PetReaction, animation: UserSelectableAnimationState | null): void {
  const overrides = { ...getPetPrefs().reactionOverrides }
  if (animation === null) delete overrides[reaction]
  else overrides[reaction] = animation
  savePetPrefs({ reactionOverrides: overrides })
  setPetReactionState(lastReaction)
}

export { showPet, hidePet, resetPetPosition, isPetVisible }
