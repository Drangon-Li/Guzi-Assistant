// 纯函数单测：桌宠 reaction→sprite 映射 + 中文消息池。运行：npm run test:petreaction
import {
  allowedReactions,
  defaultPetSprite,
  resolveReactionSpriteState,
  normalizeReactionAnimationOverrides
} from '../src/main/pet/reaction-mapping.ts'
import { pickReactionMessage, reactionMessagePools } from '../src/main/pet/reaction-messages.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const spriteStates = Object.keys(defaultPetSprite.states)

check('11 个 reaction', allowedReactions.length === 11)

let allResolve = true
for (const r of allowedReactions) {
  if (!spriteStates.includes(resolveReactionSpriteState(r, undefined))) allResolve = false
}
check('每个 reaction → 合法 sprite 状态', allResolve)

check('success → jumping', resolveReactionSpriteState('success', undefined) === 'jumping')
check('error → failed', resolveReactionSpriteState('error', undefined) === 'failed')
check('idle → idle', resolveReactionSpriteState('idle', undefined) === 'idle')
check('thinking → review', resolveReactionSpriteState('thinking', undefined) === 'review')
check('undefined → idle', resolveReactionSpriteState(undefined, undefined) === 'idle')

check('override 生效', resolveReactionSpriteState('success', { success: 'waving' }) === 'waving')
check('默认值覆盖被丢弃', normalizeReactionAnimationOverrides({ success: 'jumping' }) === undefined)
check('非法覆盖被忽略', normalizeReactionAnimationOverrides({ success: 'nope', foo: 'idle' }) === undefined)
const norm = normalizeReactionAnimationOverrides({ success: 'waving' })
check('保留真实覆盖', !!norm && norm.success === 'waving')

let poolsOk = true
for (const r of allowedReactions) {
  const pool = reactionMessagePools[r]
  if (!Array.isArray(pool) || pool.length === 0) poolsOk = false
}
check('每个 reaction 有非空消息池', poolsOk)
check('pickReactionMessage seeded 取首项', pickReactionMessage('success', () => 0) === reactionMessagePools.success[0])
check('pickReactionMessage 非空串', typeof pickReactionMessage('idle') === 'string' && pickReactionMessage('idle').length > 0)

process.exit(failed ? 1 : 0)
