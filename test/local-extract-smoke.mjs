// 纯函数单测：detectLocalSchedule（屏幕感知本地优先严格门 + 轻量时间解析）。运行：npm run test:localextract
import { detectLocalSchedule } from '../src/shared/local-extract.ts'
import { DEFAULT_SCREEN_KEYWORDS } from '../src/shared/keywords.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const NOW = new Date(2026, 5, 16, 10, 0) // 2026-06-16 周二 10:00
const det = (t) => detectLocalSchedule(t, DEFAULT_SCREEN_KEYWORDS, NOW)

// 命中：关键词 + 时间线索
const a = det('周四下午三点 产品评审会议，记得参加')
check('周四下午三点会议 → 命中', !!a)
check('  周四 → 2026-06-18 15:00', a?.isoTime === '2026-06-18T15:00')
check('  强信号(有日期)', a?.strong === true)
check('  命中关键词含会议', a?.hits.includes('会议'))

const b = det('作业截止 6月20日 前提交')
check('作业截止6月20日 → 命中', !!b)
check('  截止无钟点 → 23:59', b?.isoTime === '2026-06-20T23:59')

const c = det('今天 15:30 面试，地点 3 号楼')
check('今天15:30面试 → 命中', !!c)
check('  今天 → 2026-06-16 15:30', c?.isoTime === '2026-06-16T15:30')

const e = det('明天上午十点答辩')
check('明天上午十点答辩 → 命中', !!e)
check('  明天十点 → 2026-06-17 10:00', e?.isoTime === '2026-06-17T10:00')

// 弱信号：只有钟点没日期 → 仍返回但 strong=false（只进历史、不主动弹）
const w = det('3点开个会签到一下')
check('仅钟点 → 命中但弱信号', !!w && w.strong === false)

// 不命中
check('无关键词 → null', det('下午三点喝杯咖啡') === null)
check('有关键词无时间 → null', det('记得提交那份报告') === null)
check('空文本 → null', det('') === null)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
