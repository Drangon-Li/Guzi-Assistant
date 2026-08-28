// 纯函数单测：一轮专注的复盘证据与打断判定。运行：npm run test pomodoro-review
//
// 分工是刻意的：「切了 17 次」「短停留 62%」这类事实由代码算，模型只组织语言。
// 所以这里卡的是「事实算得对不对」和「证据不够时能不能忍住不生成」——
// 数错的复盘比没有复盘更糟。
import {
  buildRoundEvidence,
  hasEnoughEvidence,
  interruptionLevel,
  recordsInWindow,
  switchesInWindow,
  buildRoundReviewPrompt,
  INTERRUPTION_LABEL
} from '../src/shared/pomodoro-review.ts'

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const sw = (t, to, from = null) => ({ ts: `2026-08-28T${t}:00`, toApp: to, fromApp: from })
const wr = (from, to, content, task = null) => ({
  startAt: `2026-08-28T${from}:00`,
  endAt: `2026-08-28T${to}:00`,
  content,
  task
})
const FROM = '2026-08-28T10:00:00'
const TO = '2026-08-28T10:25:00'

// ---------- 窗口裁剪 ----------
const switches = [sw('09:50', 'Safari'), sw('10:05', 'Code'), sw('10:20', 'Slack'), sw('10:40', 'Mail')]
check('只取窗口内的切换', eq(switchesInWindow(switches, FROM, TO).map((s) => s.toApp), ['Code', 'Slack']))
check('边界含端点', switchesInWindow(switches, '2026-08-28T09:50:00', TO).length === 3)
check('非法窗口返回空', switchesInWindow(switches, '坏', TO).length === 0)
check('非法时间戳的事件被跳过', switchesInWindow([{ ts: '坏', toApp: 'X' }], FROM, TO).length === 0)

const records = [wr('09:00', '09:30', '早会'), wr('10:10', '10:30', '看论文', '科研'), wr('11:00', '11:30', '午休')]
check('取与窗口有交集的记录', eq(recordsInWindow(records, FROM, TO).map((r) => r.content), ['看论文']))
check('完全在窗口外的不取', recordsInWindow(records, '2026-08-28T12:00:00', '2026-08-28T13:00:00').length === 0)

// ---------- 证据组装 ----------
const base = {
  from: FROM,
  to: TO,
  minutes: 25,
  actualMinutes: 25,
  taskTitle: '看论文',
  paused: false,
  switches,
  records
}
const e = buildRoundEvidence(base)
check('切换次数', e.switchCount === 2)
check('应用按次数降序', e.apps.length === 2)
check('活动带上任务前缀', e.activities[0] === '科研：看论文')
check('平均停留 = 活跃时长/(切换+1)', e.avgSpanSec === Math.round((25 * 60) / 3))
check('计划与实际都带出来', e.minutes === 25 && e.actualMinutes === 25)
check('暂停标记透传', buildRoundEvidence({ ...base, paused: true }).paused === true)
check('切换少于两次时短停留为 null', buildRoundEvidence({ ...base, switches: [sw('10:05', 'Code')] }).shortDwell === null)
check('活动去重', buildRoundEvidence({ ...base, records: [...records, wr('10:12', '10:20', '看论文', '科研')] }).activities.length === 1)

// ---------- 证据是否够 ----------
check('有活动记录就算够', hasEnoughEvidence(e))
check(
  '切换够多也算够',
  hasEnoughEvidence(buildRoundEvidence({ ...base, records: [], switches: [sw('10:05', 'A'), sw('10:10', 'B'), sw('10:15', 'C')] }))
)
check(
  '屏幕感知没开（无切换无记录）→ 不够，不该硬生成',
  !hasEnoughEvidence(buildRoundEvidence({ ...base, switches: [], records: [] }))
)

// ---------- 打断判定 ----------
const withSwitches = (n, spacingMin = 5) =>
  buildRoundEvidence({
    ...base,
    records: [],
    actualMinutes: 60,
    from: '2026-08-28T10:00:00',
    to: '2026-08-28T11:00:00',
    switches: Array.from({ length: n }, (_, i) => {
      const m = i * spacingMin
      return sw(`${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, `App${i}`)
    })
  })
check('一小时切 2 次 → 基本没被打断', interruptionLevel(withSwitches(2)) === 'low')
check('一小时切 12 次 → 偶有切换', interruptionLevel(withSwitches(12)) === 'medium')
check('一小时切 40 次 → 打断比较多', interruptionLevel(withSwitches(40, 1)) === 'high')
check('三档都有文案', Object.keys(INTERRUPTION_LABEL).length === 3)

// ---------- 提示词 ----------
const { instructions, text } = buildRoundReviewPrompt('小李', e)
check('提示词带上用户名', instructions.includes('小李'))
check('提示词里钉死了打断判定，不让模型自由发挥', instructions.includes(INTERRUPTION_LABEL[interruptionLevel(e)]))
check('明确禁止编造', instructions.includes('不要编'))
check('要求模型不要自己算数', instructions.includes('不要自己重新计算'))
check('证据里有切换次数', text.includes('切换 2 次'))
check('证据里有关联任务', text.includes('看论文'))
const empty = buildRoundEvidence({ ...base, switches: [], records: [] })
check('没有活动记录时如实写明', buildRoundReviewPrompt('小李', empty).text.includes('没有活动记录'))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
