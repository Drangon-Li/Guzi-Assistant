// 纯函数单测：订阅制核心。运行：npm run test:subscription
import {
  DEFAULT_DAILY_QUOTA,
  extendExpiryMs,
  isSubscriptionActive,
  planById,
  PLANS,
  shouldRemindRenew,
  TRIAL_DAYS
} from '../src/shared/subscription.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const DAY = 86_400_000
const now = 1_800_000_000_000

// ---- 档位目录 ----
check('三档存在且金额为正', ['monthly', 'quarterly', 'yearly'].every((p) => PLANS[p].amountCents > 0))
check('季/年折扣低于月价线性', PLANS.quarterly.amountCents < PLANS.monthly.amountCents * 3 && PLANS.yearly.amountCents < PLANS.monthly.amountCents * 12)
check('planById 白名单命中', planById('monthly')?.days === 30)
check('planById 拒绝非法档位', planById('lifetime') === null && planById(null) === null)

// ---- 续期叠加 ----
check('未订阅过 → 从现在起算', extendExpiryMs(null, now, 30) === now + 30 * DAY)
check('未到期续费 → 顺延不吃亏', extendExpiryMs(now + 10 * DAY, now, 30) === now + 40 * DAY)
check('已过期续费 → 从现在起算', extendExpiryMs(now - 5 * DAY, now, 30) === now + 30 * DAY)

// ---- 有效性 ----
check('有效期内 active', isSubscriptionActive(now + 1, now))
check('到期即失效（边界）', !isSubscriptionActive(now, now))
check('从未订阅不 active', !isSubscriptionActive(null, now))

// ---- 续费提醒 ----
check('到期前 3 天内提醒', shouldRemindRenew(now + 2 * DAY, now))
check('到期还远不提醒', !shouldRemindRenew(now + 10 * DAY, now))
check('已过期不提醒（提醒续费的是快到期者）', !shouldRemindRenew(now - DAY, now))

// ---- 配置健全性 ----
check('试用天数为正', TRIAL_DAYS > 0)
check('每日限额覆盖重度使用', DEFAULT_DAILY_QUOTA >= 1000)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
