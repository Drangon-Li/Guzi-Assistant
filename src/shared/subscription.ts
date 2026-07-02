// 订阅制核心（积分制 → 订阅制改造）：档位目录 + 有效期纯函数。
// 单一事实源：客户端订阅面板、Edge Functions（Deno 直接 import 本文件）共用，
// 定价只在这里改。金额存「分」；chpay 为表单跳转支付，无自动续费——订阅是手动续费的时长卡。
// ⚠️ 档位/试用/限额数值为待确认的推荐默认（用户拍板后可直接改常量，逻辑与数值解耦）。

export type PlanId = 'monthly' | 'quarterly' | 'yearly'

export interface PlanDef {
  id: PlanId
  label: string
  amountCents: number
  days: number
  tag?: string
}

/** 订阅档位白名单：服务端按此定价，客户端只传 plan id，金额不再信任客户端。 */
export const PLANS: Record<PlanId, PlanDef> = {
  monthly: { id: 'monthly', label: '月度订阅', amountCents: 1990, days: 30 },
  quarterly: { id: 'quarterly', label: '季度订阅', amountCents: 5400, days: 90, tag: '约 9 折' },
  yearly: { id: 'yearly', label: '年度订阅', amountCents: 19900, days: 365, tag: '约 8.3 折' }
}

export function planById(id: string | null | undefined): PlanDef | null {
  return id && id in PLANS ? PLANS[id as PlanId] : null
}

/** 新用户注册赠送的试用天数。 */
export const TRIAL_DAYS = 7

/** 订阅期内每日公平使用上限（用量单位：文本解析 1、含图解析 2），防异常刷量。 */
export const DEFAULT_DAILY_QUOTA = 3000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 续费叠加：在「当前到期时间与现在的较大者」上加时长——
 * 未到期续费不吃亏（顺延），已到期续费从现在起算。currentMs 为 null 表示从未订阅。
 */
export function extendExpiryMs(currentMs: number | null, nowMs: number, days: number): number {
  return Math.max(currentMs ?? 0, nowMs) + days * DAY_MS
}

export function isSubscriptionActive(expiresAtMs: number | null, nowMs: number): boolean {
  return expiresAtMs !== null && expiresAtMs > nowMs
}

/** 到期前 N 天内 → 客户端提醒续费（chpay 无代扣，只能提醒手动续）。 */
export const RENEW_REMIND_DAYS = 3

export function shouldRemindRenew(expiresAtMs: number | null, nowMs: number): boolean {
  if (expiresAtMs === null) return false
  return expiresAtMs > nowMs && expiresAtMs - nowMs <= RENEW_REMIND_DAYS * DAY_MS
}
