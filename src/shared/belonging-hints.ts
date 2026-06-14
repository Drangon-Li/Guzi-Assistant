// #15 归属判断个性化学习 —— part 1：把用户纠偏积累的归属信号格式化成 prompt 片段。
// 纯函数、可测；作为「先验提示」，绝不覆盖模型对本次内容的判断（最坏情况是 no-op）。
export type BelongingPolarity = 'mine' | 'not_mine'

export interface BelongingHint {
  /** 称呼/账号/角色词，如「小王」「@zhang」「市场部」 */
  signal: string
  polarity: BelongingPolarity
}

const clean = (hints: BelongingHint[], polarity: BelongingPolarity): string[] => [
  ...new Set(
    hints
      .filter((h) => h.polarity === polarity)
      .map((h) => h.signal.trim())
      .filter(Boolean)
  )
]

/** 无信号返回 ''（便于在 buildInstructions 里条件拼接）。 */
export function buildBelongingHints(hints: BelongingHint[]): string {
  const mine = clean(hints, 'mine')
  const notMine = clean(hints, 'not_mine')
  if (!mine.length && !notMine.length) return ''
  return [
    '# 历史归属偏好（用户过往纠偏积累，仅作先验参考，仍以本次内容判断为准）',
    mine.length ? `- 这些称呼通常指本人：${mine.join('、')}` : '',
    notMine.length ? `- 这些称呼通常不是本人：${notMine.join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}
