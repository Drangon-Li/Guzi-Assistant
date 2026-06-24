// 移植自 openpets reaction-animation-mapping.ts（MIT，见 ./THIRD_PARTY_NOTICES.md）。
// 改动：内联 allowedReactions / PetReaction（去掉 local-ipc 协议依赖），sprite 行表与映射逻辑保留。

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

export type PetMotionState = 'idle' | 'run-left' | 'run-right'
export type UniversalSpriteState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'
export type UserSelectableAnimationState = Exclude<UniversalSpriteState, 'running-left' | 'running-right'>
export type ReactionAnimationOverrides = Partial<Record<PetReaction, UserSelectableAnimationState>>

export interface SpriteStateDefinition {
  readonly row: number
  readonly frames: number
  readonly durationMs: number
  readonly iterations?: number | 'infinite'
}

export const motionToSpriteState = {
  idle: 'idle',
  'run-right': 'running-right',
  'run-left': 'running-left'
} as const satisfies Record<PetMotionState, UniversalSpriteState>

export const defaultReactionToSpriteState = {
  idle: 'idle',
  thinking: 'review',
  working: 'running',
  editing: 'running',
  running: 'running',
  testing: 'waiting',
  waiting: 'waiting',
  waving: 'waving',
  success: 'jumping',
  error: 'failed',
  celebrating: 'jumping'
} as const satisfies Record<PetReaction, UserSelectableAnimationState>

export const defaultPetSprite = {
  fileName: 'default-pet-spritesheet.webp',
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
  states: {
    idle: { row: 0, frames: 6, durationMs: 5500, iterations: 'infinite' },
    'running-right': { row: 1, frames: 8, durationMs: 1060 },
    'running-left': { row: 2, frames: 8, durationMs: 1060 },
    waving: { row: 3, frames: 4, durationMs: 700, iterations: 2 },
    jumping: { row: 4, frames: 5, durationMs: 840, iterations: 2 },
    failed: { row: 5, frames: 8, durationMs: 1220, iterations: 2 },
    waiting: { row: 6, frames: 6, durationMs: 1010 },
    running: { row: 7, frames: 6, durationMs: 820 },
    review: { row: 8, frames: 6, durationMs: 1030 }
  } satisfies Record<UniversalSpriteState, SpriteStateDefinition>
} as const

export const selectableAnimationMetadata = [
  { id: 'idle', label: '待机', description: '中性 / 无特殊动作' },
  { id: 'review', label: '思考', description: '思考、阅读、检视' },
  { id: 'running', label: '工作', description: '执行、编辑、运行' },
  { id: 'waiting', label: '等待', description: '等待、阻塞、测试、待授权' },
  { id: 'waving', label: '挥手', description: '提示、打招呼、通知' },
  { id: 'jumping', label: '跳跃', description: '成功、庆祝' },
  { id: 'failed', label: '失败', description: '错误或失败' }
] as const satisfies readonly {
  readonly id: UserSelectableAnimationState
  readonly label: string
  readonly description: string
}[]

const allowedReactionSet = new Set<PetReaction>(allowedReactions)
const selectableAnimationSet = new Set<UserSelectableAnimationState>(
  selectableAnimationMetadata.map((a) => a.id)
)

export function isUserSelectableAnimationState(value: unknown): value is UserSelectableAnimationState {
  return typeof value === 'string' && selectableAnimationSet.has(value as UserSelectableAnimationState)
}

export function normalizeReactionAnimationOverrides(value: unknown): ReactionAnimationOverrides | undefined {
  if (!isRecord(value)) return undefined
  const overrides: ReactionAnimationOverrides = {}
  for (const [reaction, animation] of Object.entries(value)) {
    if (!allowedReactionSet.has(reaction as PetReaction) || !isUserSelectableAnimationState(animation)) continue
    // 与默认相同的覆盖无意义，丢弃（与 openpets 一致）
    if (defaultReactionToSpriteState[reaction as PetReaction] !== animation) {
      overrides[reaction as PetReaction] = animation
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

export function resolveReactionSpriteState(
  reaction: PetReaction | undefined,
  overrides: ReactionAnimationOverrides | undefined
): UserSelectableAnimationState {
  if (!reaction) return 'idle'
  return overrides?.[reaction] ?? defaultReactionToSpriteState[reaction] ?? 'idle'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
