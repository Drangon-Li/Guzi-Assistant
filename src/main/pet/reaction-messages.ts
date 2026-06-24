// 移植自 openpets reaction-messages.ts（MIT）。改动：中文化、去 i18n、单一消息池。
import type { PetReaction } from './reaction-mapping'

export const reactionMessagePools = {
  idle: ['待命中', '随时待命', '在的', '安静值守', '看着呢'],
  thinking: ['看一下', '理一理', '想想看', '梳理中', '读上下文'],
  working: ['处理中', '在忙这个', '推进中', '进行中', '马上好'],
  editing: ['整理中', '改一改', '收拾一下', '更新中'],
  running: ['开始了', '跑起来了', '执行中', '等结果'],
  testing: ['核对中', '验一下', '看看结果', '确认中'],
  waiting: ['等你定一下', '需要你确认', '卡这儿了', '等你拍板'],
  waving: ['嗨', '看这边', '提醒一下', '叮~', '有动静'],
  success: ['搞定', '完成啦', '收工', '过了', '好了'],
  error: ['出问题了', '需要看看', '失败了', '卡住了'],
  celebrating: ['干得漂亮', '成了', '漂亮', '庆祝一下', '赢了']
} as const satisfies Record<PetReaction, readonly string[]>

export function pickReactionMessage(reaction: PetReaction, random: () => number = Math.random): string {
  const pool = reactionMessagePools[reaction]
  return pool[Math.floor(random() * pool.length) % pool.length] ?? reaction
}
