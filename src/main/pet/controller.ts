// 桌宠控制器：EShell 事件层驱动桌宠的唯一调用面。
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
import {
  defaultPetSprite,
  resolveReactionSpriteState,
  type PetReaction,
  type SpriteStateDefinition
} from './reaction-mapping'
import { pickReactionMessage } from './reaction-messages'
import { getPetPrefs, savePetPrefs, type PetScaleValue } from './state'

let lastReaction: PetReaction = 'idle'
let revertTimer: ReturnType<typeof setTimeout> | null = null
let sayTimer: ReturnType<typeof setTimeout> | null = null
let sayToken = 0

// 桌宠停用或暂停时，事件不打扰（暂停 = 冻结安静；停用 = 隐藏）。
function quiet(): boolean {
  const p = getPetPrefs()
  return p.paused || !p.enabled
}

function spriteIterations(reaction: PetReaction): number | 'infinite' {
  const sprite = resolveReactionSpriteState(reaction, getPetPrefs().reactionOverrides)
  const def: SpriteStateDefinition = defaultPetSprite.states[sprite]
  return def.iterations ?? 'infinite'
}
function spriteDurationMs(reaction: PetReaction): number {
  const sprite = resolveReactionSpriteState(reaction, getPetPrefs().reactionOverrides)
  return defaultPetSprite.states[sprite].durationMs
}

/** 播放一个 reaction 动画；有限次数动画播完自动回 idle；可附带一句自动台词。 */
export function applyExternalPetReaction(reaction: PetReaction, opts: { showMessage?: boolean } = {}): void {
  if (quiet()) return
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

/** 显示一句气泡，到时清除。reaction 直接随气泡传入（决定气泡色调），不读全局态——避免并发事件串色。 */
export function applyExternalPetSay(message: string, reaction?: PetReaction, opts: { durationMs?: number } = {}): void {
  if (quiet()) return
  if (reaction) {
    lastReaction = reaction
    setPetReactionState(reaction)
  }
  setPetBubble(message, reaction ?? lastReaction)
  const token = ++sayToken
  if (sayTimer) clearTimeout(sayTimer)
  sayTimer = setTimeout(() => {
    if (token === sayToken) setPetBubble(null)
  }, opts.durationMs ?? 4200)
  sayTimer.unref?.()
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
export function setPetEnabled(enabled: boolean): void {
  savePetPrefs({ enabled })
  if (enabled) showPet()
  else hidePet()
}

export { showPet, hidePet, resetPetPosition, isPetVisible }
