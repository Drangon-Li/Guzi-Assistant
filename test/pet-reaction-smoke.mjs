// 纯函数单测：桌宠 reaction 列表 + 中文消息池（动画已移除，桌宠为静态图标）。运行：npm run test:petreaction
import { allowedReactions } from '../src/main/pet/reaction-mapping.ts'
import { pickReactionMessage, reactionMessagePools } from '../src/main/pet/reaction-messages.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

check('11 个 reaction', allowedReactions.length === 11)

let poolsOk = true
for (const r of allowedReactions) {
  const pool = reactionMessagePools[r]
  if (!Array.isArray(pool) || pool.length === 0) poolsOk = false
}
check('每个 reaction 有非空消息池', poolsOk)
check('pickReactionMessage seeded 取首项', pickReactionMessage('success', () => 0) === reactionMessagePools.success[0])
check('pickReactionMessage 非空串', typeof pickReactionMessage('idle') === 'string' && pickReactionMessage('idle').length > 0)

process.exit(failed ? 1 : 0)
