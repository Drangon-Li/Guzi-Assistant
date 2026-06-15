// 积分计费核心（#41/#56）离线单测。运行：npm run test:billing
import {
  creditCost,
  totalBalance,
  canAfford,
  applyMonthlyGrant,
  deduct,
  addPurchase,
  chargeAction,
  DEFAULT_MONTHLY_GRANT
} from '../server/billing/credits.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const DAY = 24 * 60 * 60 * 1000

// 成本表
check('文本解析/对话/监控 = 1', creditCost('chat') === 1 && creditCost('parse_text') === 1 && creditCost('monitor_trigger') === 1)
check('vision = 2', creditCost('parse_vision') === 2)
check('失败 = 0', creditCost('failed') === 0)
check('pHash 跳过 = 0', creditCost('phash_skip') === 0)

// 扣费优先级：先赠送后购买
const s0 = { grant: 5, grantResetAtMs: 10 * DAY, purchased: 100 }
const d1 = deduct(s0, 3)
check('够付：扣赠送', d1.ok && eq(d1.state, { grant: 2, grantResetAtMs: 10 * DAY, purchased: 100 }))
const d2 = deduct(s0, 8)
check('赠送不够：先清赠送再扣购买', d2.ok && eq(d2.state, { grant: 0, grantResetAtMs: 10 * DAY, purchased: 97 }))

// 余额不足不扣
const poor = { grant: 1, grantResetAtMs: 10 * DAY, purchased: 0 }
const d3 = deduct(poor, 5)
check('余额不足：ok:false 且不扣', !d3.ok && eq(d3.state, poor))

// 0 成本（失败/跳过）不扣
check('cost<=0 不扣、ok', deduct(poor, 0).ok && eq(deduct(poor, 0).state, poor))

check('totalBalance', totalBalance(s0) === 105)
check('canAfford', canAfford(s0, 105) && !canAfford(s0, 106))

// 月度重置
const before = { grant: 3, grantResetAtMs: 100 * DAY, purchased: 50 }
check('未到重置点：不动', eq(applyMonthlyGrant(before, 99 * DAY), before))
const after = applyMonthlyGrant(before, 101 * DAY, 1000, 30 * DAY)
check('过重置点：赠送重置为 monthly、购买不动', after.grant === 1000 && after.purchased === 50)
check('重置后 resetAt 推到 now 之后', after.grantResetAtMs > 101 * DAY)
// 跨多个空闲周期只重置一次（不累积成 2000）
const longIdle = applyMonthlyGrant({ grant: 0, grantResetAtMs: 0, purchased: 0 }, 95 * DAY, 1000, 30 * DAY)
check('跨多周期只重置一次', longIdle.grant === 1000 && longIdle.grantResetAtMs > 95 * DAY)

// 充值
check('addPurchase 加到购买余额', addPurchase(s0, 300).purchased === 400)
check('addPurchase 负数被夹', addPurchase(s0, -10).purchased === 100)

// chargeAction 一把梭
const cs = { grant: 0, grantResetAtMs: 100 * DAY, purchased: 0 }
const ca = chargeAction(cs, 'chat', 101 * DAY) // 先重置 grant=1000 再扣 1
check('chargeAction：重置+扣费', ca.ok && ca.cost === 1 && ca.state.grant === DEFAULT_MONTHLY_GRANT - 1)
const caFail = chargeAction({ grant: 0, grantResetAtMs: 200 * DAY, purchased: 0 }, 'parse_vision', 101 * DAY)
check('chargeAction：余额不足 ok:false', !caFail.ok && caFail.cost === 2)
const caFree = chargeAction({ grant: 0, grantResetAtMs: 200 * DAY, purchased: 0 }, 'failed', 101 * DAY)
check('chargeAction：失败动作 0 扣 ok', caFree.ok && caFree.cost === 0)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
