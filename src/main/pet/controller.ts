// 桌宠控制器：EShell 事件层驱动桌宠的唯一调用面。
// 移植/精简自 openpets default-pet-controller.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
import {
  hidePet,
  isPetVisible,
  resetPetPosition,
  setPetBubble,
  setPetListening as setPetListeningWin,
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
let processingBubble = false // 当前气泡是否为「正在处理中～」：处理结束时只清自己的，别误清后来的消息

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
  if (quiet() || !getPetPrefs().bubbles) return
  if (reaction) lastReaction = reaction
  processingBubble = false
  setPetBubble(message, reaction ?? lastReaction)
  const token = ++sayToken
  if (sayTimer) clearTimeout(sayTimer)
  sayTimer = setTimeout(() => {
    if (token === sayToken) setPetBubble(null)
  }, opts.durationMs ?? 4200)
  sayTimer.unref?.()
}

/** 扫描/解析中：光环 + 常驻「正在处理中～」气泡（气泡开关关时只亮光环）。off 总是放行，确保能清掉。 */
export function setPetScanning(on: boolean): void {
  if (on && quiet()) return
  setPetScanningWin(on)
  if (on && getPetPrefs().bubbles) {
    if (sayTimer) clearTimeout(sayTimer)
    sayToken++ // 使在途的自动清除失效，处理期间气泡常驻
    processingBubble = true
    setPetBubble('正在处理中～', 'working')
  } else if (!on && processingBubble) {
    // 只清自己的气泡；若处理结果消息（如「发现一个日程~」）已经顶掉它，别把结果误清
    processingBubble = false
    setPetBubble(null)
  }
}

/** 长按聆听：声波涟漪 + 常驻「我正在听～」气泡，松开清除。与处理光环视觉区分。
 *  聆听气泡不受气泡开关控制——它是用户主动按出来的即时反馈，不算打扰。 */
export function setPetListening(on: boolean): void {
  if (on && quiet()) return
  setPetListeningWin(on)
  if (sayTimer) clearTimeout(sayTimer)
  sayToken++ // 使在途的气泡自动清除失效，防止把聆听气泡按住期间提前清掉
  processingBubble = false
  setPetBubble(on ? '我正在听～' : null, 'waiting')
}

/** 设置页「气泡提醒」总开关。 */
export function setPetBubblesEnabled(on: boolean): void {
  savePetPrefs({ bubbles: on })
  if (!on) setPetBubble(null) // 关掉时清掉当前挂着的气泡
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
