// 纯函数单测：注意力分析指标。运行：npm run test:attention
import {
  ATTENTION_BASELINE_SEC,
  avgAttentionSpanSec,
  buildOverrideMap,
  categoryOf,
  deepBlockCount,
  deepWorkSeconds,
  focusScore,
  hourlySwitches,
  longestRunSeconds,
  productiveRuns,
  shortDwellShare
} from '../src/shared/attention.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- categoryOf ----
const noOv = new Map()
check('VS Code → 专注', categoryOf('Code', noOv) === 'productive')
check('iTerm2 → 专注', categoryOf('iTerm2', noOv) === 'productive')
check('哔哩哔哩 → 分心', categoryOf('bilibili', noOv) === 'distracting')
check('微信 → 中性（默认）', categoryOf('微信', noOv) === 'neutral')
check('Chrome → 中性', categoryOf('Google Chrome', noOv) === 'neutral')
const ov = buildOverrideMap([{ app: '微信', category: 'productive' }])
check('用户覆盖优先', categoryOf('微信', ov) === 'productive')
check('覆盖不影响他项', categoryOf('bilibili', ov) === 'distracting')

// ---- avgAttentionSpanSec ----
check('基准常量 47s', ATTENTION_BASELINE_SEC === 47)
check('3600s 活跃 59 次切换 → 60s', avgAttentionSpanSec(3600, 59) === 60)
check('0 切换 = 全时长', avgAttentionSpanSec(1800, 0) === 1800)
check('无活跃 → null', avgAttentionSpanSec(0, 5) === null)

// ---- focusScore ----
const cat = (app) => categoryOf(app, noOv)
check('全专注 = 100', focusScore([{ app: 'Code', seconds: 100 }], cat) === 100)
check('全分心 = 0', focusScore([{ app: 'bilibili', seconds: 100 }], cat) === 0)
check('全中性 = 50', focusScore([{ app: '微信', seconds: 100 }], cat) === 50)
check(
  '混合加权',
  focusScore(
    [
      { app: 'Code', seconds: 3600 }, // 4×3600
      { app: 'bilibili', seconds: 1800 } // 0
    ],
    cat
  ) === Math.round(((3600 * 4) / (5400 * 4)) * 100)
)
check('空数据 → null', focusScore([], cat) === null)

// ---- productiveRuns / deepWork ----
const wr = (t, app) => ({ id: t, content: 'x', app, task: null, createdAt: `2026-07-02T${t}` })
const runs = productiveRuns(
  [
    wr('09:00', 'Code'),
    wr('09:05', 'Code'),
    wr('09:20', 'Code'), // 间隔 15min > 10min → 切段：[09:00-09:05], [09:20…]
    wr('09:25', 'Code'),
    wr('09:30', '微信'), // 中性不参与
    wr('09:40', 'Code')
  ],
  cat
)
check('分成 3 段', runs.length === 3)
check('第一段 6 分钟', runs[0].seconds === 6 * 60)
check('第二段 09:20–09:25', runs[1].start.endsWith('09:20') && runs[1].seconds === 6 * 60)
check('单条段算 1 分钟', runs[2].seconds === 60)
const longRuns = productiveRuns(
  [wr('10:00', 'Code'), wr('10:08', 'Code'), wr('10:16', 'Code'), wr('10:24', 'Code')],
  cat
)
check('25 分钟段计深度工作', deepWorkSeconds(longRuns) === 25 * 60)
check('短段不计深度工作', deepWorkSeconds(runs) === 0)
check('深度块数', deepBlockCount(longRuns) === 1 && deepBlockCount(runs) === 0)
check('最长专注块', longestRunSeconds(longRuns) === 25 * 60)
check('空记录 → 空段', productiveRuns([], cat).length === 0)

// ---- hourlySwitches / shortDwellShare ----
const sw = (t) => ({ ts: `2026-07-02T${t}`, fromApp: 'A', toApp: 'B' })
const hs = hourlySwitches([sw('09:01'), sw('09:30'), sw('14:00')])
check('小时分布', hs[9] === 2 && hs[14] === 1 && hs[0] === 0)
check(
  '短停留占比：3 次切换 2 个间隔 1 短',
  shortDwellShare([sw('09:00'), sw('09:01'), sw('09:30')]) === 0.5
)
check('切换不足 → null', shortDwellShare([sw('09:00')]) === null)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
