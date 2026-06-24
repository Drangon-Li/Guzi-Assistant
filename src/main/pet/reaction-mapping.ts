// 桌宠反应类型 —— 仅用于事件气泡的台词池与色调（动画/sprite 渲染已移除，桌宠为静态品牌标）。

export const allowedReactions = [
  'idle',
  'thinking',
  'working',
  'editing',
  'running',
  'testing',
  'waiting',
  'waving',
  'success',
  'error',
  'celebrating'
] as const
export type PetReaction = (typeof allowedReactions)[number]

/** 桌宠图标画布尺寸（窗口/缩放/hitbox 计算用；竖向略高于宽以给气泡留位）。 */
export const PET_ART_WIDTH = 192
export const PET_ART_HEIGHT = 208
