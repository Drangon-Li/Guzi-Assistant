/**
 * 积分计费核心（#41 用量计费 / #56 积分模型）—— 架构无关、离线可测、**仅服务端**。
 *
 * 把 #56「让用户心安」的积分规则落成纯函数，持久化层（Supabase / 任意 DB）只管存取这些状态、
 * 调用这里的逻辑。**不碰真钱、不需任何凭据、不开通任何基础设施**——和已合的 chpay 签名核心
 * (server/chpay) 同性质：owner 后续接 DB / 模型网关 / 真商户即可，本模块零依赖。
 *
 * 心安规则（#56）：
 * - 失败 / pHash 跳过 = 0 扣（creditCost 返 0）。
 * - 扣费优先级：先扣「当月赠送」（到期清零）→ 再扣「购买积分」（不过期）→ 用户的真金白银不被白挤掉。
 * - 余额不足不扣（返 ok:false），由调用方决定降级 / 提示加购。
 */

/** 计费动作 → 积分消耗（#56 表）。数值是产品配置，逻辑与具体数字解耦。 */
export type BillableAction =
  | 'chat'
  | 'parse_text'
  | 'parse_vision'
  | 'monitor_trigger'
  | 'phash_skip'
  | 'failed'

export function creditCost(action: BillableAction): number {
  switch (action) {
    case 'parse_vision':
      return 2 // 含图/截图解析（vision 更贵）
    case 'chat':
    case 'parse_text':
    case 'monitor_trigger':
      return 1
    case 'phash_skip': // 本地去重命中、未触发 LLM
    case 'failed': // 请求失败/超时/报错
      return 0
  }
}

export interface CreditState {
  /** 当月赠送余额（到期清零） */
  grant: number
  /** 赠送下次重置的时间戳（ms） */
  grantResetAtMs: number
  /** 购买积分余额（不过期/长有效） */
  purchased: number
}

/** 会员每月赠送积分（#56 推荐 1000）。数值可配，不写死进逻辑。 */
export const DEFAULT_MONTHLY_GRANT = 1000
const DEFAULT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000

export function totalBalance(s: CreditState): number {
  return s.grant + s.purchased
}

export function canAfford(s: CreditState, cost: number): boolean {
  return totalBalance(s) >= cost
}

/**
 * 跨过重置点则把赠送重置为 monthly，并把 resetAt 推到 now 之后的下一个周期边界
 * （跨多个空闲周期也只重置一次、不累积）。纯函数。
 * 生产可传日历月算出的 periodMs / 或在持久层用真实日历边界；核心用固定周期保持可测。
 */
export function applyMonthlyGrant(
  state: CreditState,
  nowMs: number,
  monthly: number = DEFAULT_MONTHLY_GRANT,
  periodMs: number = DEFAULT_PERIOD_MS
): CreditState {
  if (nowMs < state.grantResetAtMs) return state
  let next = state.grantResetAtMs
  while (next <= nowMs) next += periodMs
  return { ...state, grant: monthly, grantResetAtMs: next }
}

/**
 * 扣费：先扣赠送（当月到期）→ 再扣购买（不过期）= 钱不浪费。
 * cost<=0（失败/跳过）一律 ok 且不扣；余额不足 ok:false 不扣（调用方降级/提示加购）。
 */
export function deduct(state: CreditState, cost: number): { ok: boolean; state: CreditState } {
  if (cost <= 0) return { ok: true, state }
  if (!canAfford(state, cost)) return { ok: false, state }
  const fromGrant = Math.min(state.grant, cost)
  const fromPurchased = cost - fromGrant
  return {
    ok: true,
    state: { ...state, grant: state.grant - fromGrant, purchased: state.purchased - fromPurchased }
  }
}

/** 充值积分包 → 加到购买余额（不过期）。 */
export function addPurchase(state: CreditState, credits: number): CreditState {
  return { ...state, purchased: state.purchased + Math.max(0, Math.floor(credits)) }
}

/** 便捷：按动作扣费（先 applyMonthlyGrant 再 deduct）。 */
export function chargeAction(
  state: CreditState,
  action: BillableAction,
  nowMs: number,
  monthly: number = DEFAULT_MONTHLY_GRANT
): { ok: boolean; cost: number; state: CreditState } {
  const refreshed = applyMonthlyGrant(state, nowMs, monthly)
  const cost = creditCost(action)
  const r = deduct(refreshed, cost)
  return { ok: r.ok, cost, state: r.state }
}
