// 桌宠控制器：EShell 事件层驱动桌宠的唯一调用面。
// 移植/精简自 openpets default-pet-controller.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
import {
  hidePet,
  isPetVisible,
  resetPetPosition,
  setPetBubble,
  setPetPaused,
  setPetScale,
  setPetScanning as setPetScanningWin,
  showPet
} from './pet-window'
import { type PetReaction } from './reaction-mapping'
import { pickReactionMessage } from './reaction-messages'
import { getPetPrefs, savePetPrefs, type PetScaleValue } from './state'

let lastReaction: PetReaction = 'idle'
let sayTimer: ReturnType<typeof setTimeout> | null = null
let sayToken = 0

// 桌宠停用或暂停时，事件不打扰（暂停 = 冻结安静；停用 = 隐藏）。
function quiet(): boolean {
  const p = getPetPrefs()
  return p.paused || !p.enabled
}

/** 事件反应：桌宠为静态图标，反应只决定是否弹一句对应台词的气泡及其色调。 */
export function applyExternalPetReaction(reaction: PetReaction, opts: { showMessage?: boolean } = {}): void {
  if (quiet()) return
  lastReaction = reaction
  if (opts.showMessage !== false) applyExternalPetSay(pickReactionMessage(reaction), reaction)
}

/** 显示一句气泡，到时清除。reaction 直接随气泡传入（决定气泡色调），不读全局态——避免并发事件串色。 */
export function applyExternalPetSay(message: string, reaction?: PetReaction, opts: { durationMs?: number } = {}): void {
  if (quiet()) return
  if (reaction) lastReaction = reaction
  setPetBubble(message, reaction ?? lastReaction)
  const token = ++sayToken
  if (sayTimer) clearTimeout(sayTimer)
  sayTimer = setTimeout(() => {
    if (token === sayToken) setPetBubble(null)
  }, opts.durationMs ?? 4200)
  sayTimer.unref?.()
}

/** 扫描/解析中显示桌宠光环；停用或暂停时不亮（off 总是放行，确保能清掉）。 */
export function setPetScanning(on: boolean): void {
  if (on && quiet()) return
  setPetScanningWin(on)
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
