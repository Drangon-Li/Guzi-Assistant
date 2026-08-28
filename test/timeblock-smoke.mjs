// 纯函数单测：作息插件的时间换算、重叠、空档、模板套用。运行：npm run test timeblock
import {
  conflictsWith,
  coverageOf,
  durationLabel,
  freeGaps,
  isValidRange,
  labelToMinutes,
  minutesToLabel,
  overlaps,
  plannedMinutes,
  sortBlocks,
  templateForDate,
  applyTemplate,
  weekdaysLabel
} from '../src/shared/timeblock.ts'

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 时刻换算 ----------
check('分钟 → HH:MM', minutesToLabel(660) === '11:00')
check('补零', minutesToLabel(65) === '01:05')
check('1440 显示 24:00（「到当天结束」比 00:00 好读）', minutesToLabel(1440) === '24:00')
check('越界夹到 0', minutesToLabel(-10) === '00:00')
check('HH:MM → 分钟', labelToMinutes('11:00') === 660)
check('单位数小时也认', labelToMinutes('9:30') === 570)
check('24:00 合法', labelToMinutes('24:00') === 1440)
check('24:01 非法', labelToMinutes('24:01') === null)
check('分钟越界非法', labelToMinutes('10:75') === null)
check('乱输入返回 null', labelToMinutes('中午') === null)
check('往返一致', labelToMinutes(minutesToLabel(837)) === 837)

check('时长：整小时', durationLabel(600, 660) === '1 小时')
check('时长：时+分', durationLabel(600, 690) === '1 小时 30 分钟')
check('时长：不足一小时', durationLabel(600, 630) === '30 分钟')

// ---------- 区间合法性 ----------
check('正常区间合法', isValidRange(600, 660))
check('零长非法', !isValidRange(600, 600))
check('倒置非法', !isValidRange(660, 600))
check('超过一天非法', !isValidRange(600, 1441))
check('负数非法', !isValidRange(-1, 60))
check('小数非法', !isValidRange(600.5, 660))

// ---------- 重叠 ----------
const a = { startMin: 600, endMin: 660 }
check('相交算重叠', overlaps(a, { startMin: 630, endMin: 700 }))
check('包含算重叠', overlaps(a, { startMin: 610, endMin: 620 }))
check('相邻不算重叠（前一段的 end 等于后一段的 start）', !overlaps(a, { startMin: 660, endMin: 700 }))
check('不相干不算', !overlaps(a, { startMin: 700, endMin: 720 }))

const blocks = [
  { id: 'x', startMin: 600, endMin: 660 },
  { id: 'y', startMin: 640, endMin: 700 },
  { id: 'z', startMin: 800, endMin: 900 }
]
check('找出冲突', eq(conflictsWith(blocks, { startMin: 650, endMin: 670 }).map((b) => b.id), ['x', 'y']))
check('忽略自己', eq(conflictsWith(blocks, blocks[0], 'x').map((b) => b.id), ['y']))
check('没有冲突返回空', conflictsWith(blocks, { startMin: 1000, endMin: 1100 }).length === 0)

check('按开始时间排序', eq(sortBlocks([blocks[2], blocks[0]]).map((b) => b.id), ['x', 'z']))

// ---------- 空档 ----------
const gaps = freeGaps([{ startMin: 600, endMin: 660 }], 540, 780)
check('前后各一段空档', eq(gaps, [{ startMin: 540, endMin: 600 }, { startMin: 660, endMin: 780 }]))
check(
  '重叠的块合并后再算空档',
  eq(freeGaps([{ startMin: 600, endMin: 700 }, { startMin: 650, endMin: 800 }], 600, 900), [
    { startMin: 800, endMin: 900 }
  ])
)
check('太短的空档被滤掉', freeGaps([{ startMin: 600, endMin: 660 }], 590, 660, 15).length === 0)
check('全空则整段是空档', eq(freeGaps([], 0, 60), [{ startMin: 0, endMin: 60 }]))

check('已排分钟数（重叠只算一次）', plannedMinutes([{ startMin: 600, endMin: 700 }, { startMin: 650, endMin: 800 }]) === 200)
check('没排任何块 → 0', plannedMinutes([]) === 0)

// ---------- 计划 vs 实际 ----------
const block = { startMin: 600, endMin: 700 }
check('完全覆盖 → 1', coverageOf(block, [{ startMin: 590, endMin: 720 }]) === 1)
check('覆盖一半 → 0.5', coverageOf(block, [{ startMin: 600, endMin: 650 }]) === 0.5)
check('没有交集 → 0', coverageOf(block, [{ startMin: 800, endMin: 900 }]) === 0)
check(
  '实际区间互相重叠时不重复计数',
  coverageOf(block, [{ startMin: 600, endMin: 660 }, { startMin: 620, endMin: 650 }]) === 0.6
)

// ---------- 模板 ----------
const tpl = { id: 't1', name: '工作日', weekdays: [1, 2, 3, 4, 5], createdAt: '2026-01-01T00:00:00' }
const tplBlocks = [
  { id: 'b2', templateId: 't1', startMin: 780, endMin: 840, title: '午饭', tag: null },
  { id: 'b1', templateId: 't1', startMin: 660, endMin: 780, title: '看论文', tag: '科研' },
  { id: 'other', templateId: 't2', startMin: 600, endMin: 660, title: '别的模板', tag: null }
]
const drafts = applyTemplate(tpl, tplBlocks, '2026-08-28')
check('只取本模板的块', drafts.length === 2)
check('按时间排序', eq(drafts.map((d) => d.title), ['看论文', '午饭']))
check('日期写进草稿', drafts.every((d) => d.date === '2026-08-28'))
check('标记来源模板（套用时可整批替换）', drafts.every((d) => d.templateId === 't1'))
check('标签带过来', drafts[0].tag === '科研')

// 2026-08-28 是周五
check('工作日模板命中周五', templateForDate([tpl], '2026-08-28')?.id === 't1')
check('周六不命中', templateForDate([tpl], '2026-08-29') === null)
check('没有模板返回 null', templateForDate([], '2026-08-28') === null)
const older = { ...tpl, id: 't0', createdAt: '2025-01-01T00:00:00' }
check('命中多个取最早建的', templateForDate([tpl, older], '2026-08-28')?.id === 't0')
check('非法日期返回 null', templateForDate([tpl], '不是日期') === null)

check('连续星期用区间表述', weekdaysLabel([1, 2, 3, 4, 5]) === '周一至周五')
check('全选说「每天」', weekdaysLabel([0, 1, 2, 3, 4, 5, 6]) === '每天')
check('不连续则列举', weekdaysLabel([1, 3, 5]) === '周一、周三、周五')
check('两天也列举', weekdaysLabel([1, 2]) === '周一、周二')
check('空数组说不自动套用', weekdaysLabel([]) === '不自动套用')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
