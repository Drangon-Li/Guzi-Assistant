// 纯函数单测：buildBelongingHints（#15 part 1）。运行：npm run test:hints
import { buildBelongingHints } from '../src/shared/belonging-hints.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

check('无信号 → 空串', buildBelongingHints([]) === '')
check('全空白信号 → 空串', buildBelongingHints([{ signal: '  ', polarity: 'mine' }]) === '')

const onlyMine = buildBelongingHints([
  { signal: '小王', polarity: 'mine' },
  { signal: '@zhang', polarity: 'mine' }
])
check('仅本人 → 含本人行与信号', onlyMine.includes('通常指本人：小王、@zhang'))
check('仅本人 → 不含「不是本人」行', !onlyMine.includes('不是本人'))
check('含表头', onlyMine.includes('历史归属偏好'))

const onlyNot = buildBelongingHints([{ signal: '市场部', polarity: 'not_mine' }])
check('仅非本人 → 含非本人行', onlyNot.includes('通常不是本人：市场部') && !onlyNot.includes('通常指本人'))

const both = buildBelongingHints([
  { signal: '小王', polarity: 'mine' },
  { signal: '老板', polarity: 'not_mine' }
])
check('两类都有 → 两行齐全', both.includes('通常指本人：小王') && both.includes('通常不是本人：老板'))

const dup = buildBelongingHints([
  { signal: '小王', polarity: 'mine' },
  { signal: ' 小王 ', polarity: 'mine' },
  { signal: '小王', polarity: 'mine' }
])
check('去重+去空白', dup.includes('通常指本人：小王') && !dup.includes('小王、小王'))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
