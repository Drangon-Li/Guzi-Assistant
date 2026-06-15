// 截图保留期（#53）离线单测。运行：npm run test:shotret
import { expiredShotIds } from '../src/shared/shot-retention.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const DAY = 24 * 60 * 60 * 1000
const now = 1_000 * DAY
const refs = [
  { id: 'old', createdAtMs: now - 20 * DAY },
  { id: 'fresh', createdAtMs: now - 2 * DAY },
  { id: 'edge', createdAtMs: now - 14 * DAY }
]

check('14 天保留：只删 20 天前', eq(expiredShotIds(refs, 14, now), ['old']))
check('正好 14 天=边界保留(不删，严格 <)', !expiredShotIds(refs, 14, now).includes('edge'))
check('2 天前不删', !expiredShotIds(refs, 14, now).includes('fresh'))
check('7 天保留更激进', eq(expiredShotIds(refs, 7, now), ['old', 'edge']))
check('30 天保留只删最老', eq(expiredShotIds(refs, 30, now), []))
check('retentionDays=0 永久保留→不删', eq(expiredShotIds(refs, 0, now), []))
check('retentionDays<0→不删', eq(expiredShotIds(refs, -1, now), []))
check('NaN createdAt 跳过', eq(expiredShotIds([{ id: 'x', createdAtMs: NaN }], 1, now), []))
check('空列表→空', eq(expiredShotIds([], 14, now), []))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
