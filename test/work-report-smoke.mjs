// 纯函数单测：工作日报 work-report + 屏幕扫描 work_summary 解析。运行：npm run test:workreport
import {
  dayKey,
  formatDuration,
  defaultReportTitle,
  splitTasksForDay,
  buildDailyReportPrompt,
  groupWorkPeriods,
  periodLabel,
  focusDurations,
  isAppNameTask,
  isGenericFocusTask,
  normalizeTaskKey,
  normalizeTaskLabel,
  timeRangeLabel,
  daySegmentOf,
  memoryToPlain,
  plainToMemory
} from '../src/shared/work-report.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- dayKey ----
check('dayKey 补零', dayKey(new Date(2026, 0, 5)) === '2026-01-05')
check('dayKey 双位月日', dayKey(new Date(2026, 11, 31)) === '2026-12-31')

// ---- formatDuration ----
check('秒级', formatDuration(45) === '45 秒')
check('分钟级', formatDuration(150) === '3 分钟')
check('整小时', formatDuration(7200) === '2 小时')
check('时+分', formatDuration(3900) === '1 小时 5 分钟')

// ---- defaultReportTitle ----
check('标题含日期', defaultReportTitle('2026-07-02') === '2026-07-02 工作日报')

// ---- splitTasksForDay ----
function mk(o) {
  return {
    id: 'x',
    sourceId: null,
    title: 't',
    itemType: 'reminder',
    belongsToUser: 'yes',
    belongingReason: '',
    userRole: 'owner',
    startTime: null,
    dueTime: null,
    location: null,
    priority: 'unknown',
    confidence: 0.9,
    suggestedAction: 'confirm',
    evidence: [],
    notes: [],
    duplicateOf: null,
    status: 'scheduled',
    feedback: null,
    createdAt: '',
    updatedAt: '',
    ...o
  }
}
const tasks = [
  mk({ title: '今天完成的', status: 'done', updatedAt: '2026-07-02T15:00' }),
  mk({ title: '昨天完成的', status: 'done', updatedAt: '2026-07-01T15:00' }),
  mk({ title: '待办中', status: 'scheduled' }),
  mk({ title: '别人的', status: 'scheduled', belongsToUser: 'no' }),
  mk({ title: '已忽略', status: 'ignored' })
]
const split = splitTasksForDay(tasks, '2026-07-02')
check('done 只取当天完成', split.done.length === 1 && split.done[0] === '今天完成的')
check('open 排除别人的/已忽略', split.open.length === 1 && split.open[0] === '待办中')

// ---- buildDailyReportPrompt ----
const { instructions, text } = buildDailyReportPrompt('张三', {
  day: '2026-07-02',
  records: [{ id: 'r1', content: '在 VS Code 编辑代码', app: 'Code', createdAt: '2026-07-02T09:30' }],
  usage: [{ app: 'Code', seconds: 3600 }],
  tasksDone: ['修好登录 bug'],
  tasksOpen: ['写周报']
})
check('系统提示词含用户名', instructions.includes('张三'))
check('系统提示词含结构要求', instructions.includes('## 今日概览') && instructions.includes('## 明日计划'))
check('素材含时间线（时刻+应用+内容）', text.includes('09:30 [Code] 在 VS Code 编辑代码'))
check('素材含应用时长', text.includes('Code：1 小时'))
check('素材含完成任务与待办', text.includes('修好登录 bug') && text.includes('写周报'))

const empty = buildDailyReportPrompt('张三', {
  day: '2026-07-02',
  records: [],
  usage: [],
  tasksDone: [],
  tasksOpen: []
})
check('空素材各节标注（无）', (empty.text.match(/（无）/g) ?? []).length === 5)

// ---- groupWorkPeriods ----
const wr = (t, content, app) => ({ id: t, content, app: app ?? 'Code', createdAt: `2026-07-02T${t}` })
const periods = groupWorkPeriods([
  wr('09:00', '在 VS Code 写代码'),
  wr('09:03', '在 VS Code 写代码'),
  wr('09:06', '在 VS Code 调试'), // 同 app 小间隔 → 同段
  wr('09:40', '在浏览器查文档', 'Chrome'), // 换 app → 新段
  wr('11:00', '在 VS Code 写代码') // 同 app 但大间隔 → 新段
])
check('聚合成 3 段', periods.length === 3)
check('第一段跨 09:00–09:06', periods[0].start.endsWith('09:00') && periods[0].end.endsWith('09:06'))
check('第一段代表描述取最高频', periods[0].summary === '在 VS Code 写代码')
check('第一段含 2 项活动', periods[0].activities.length === 2)
check('第一段收集全部 id', periods[0].ids.length === 3)
check('换应用切段', periods[1].app === 'Chrome')
check('大间隔切段', periods[2].start.endsWith('11:00'))
check('periodLabel 区间', periodLabel(periods[0]) === '09:00–09:06')
check('periodLabel 单点', periodLabel(periods[1]) === '09:40')
check('空输入 → 空', groupWorkPeriods([]).length === 0)
check('乱序输入按时间排序', (() => {
  const p = groupWorkPeriods([wr('09:06', 'x'), wr('09:00', 'x'), wr('09:03', 'x')])
  return p.length === 1 && p[0].start.endsWith('09:00')
})())
const wrInterval = (id, startAt, endAt, task) => ({
  id,
  content: 'x',
  app: 'Code',
  task,
  source: 'accessibility',
  derivedBy: 'history',
  segmentId: id,
  startAt,
  endAt,
  confidence: 0.8,
  evidenceCount: 1,
  summaryHash: id,
  createdAt: endAt
})
check('工作记录 task 变化会切开时段', groupWorkPeriods([
  wrInterval('task-1', '2026-07-02T12:00:00.000Z', '2026-07-02T12:05:00.000Z', '任务 A'),
  wrInterval('task-2', '2026-07-02T12:06:00.000Z', '2026-07-02T12:10:00.000Z', '任务 B')
]).length === 2)
check('空 task 不会与有 task 的记录合并', groupWorkPeriods([
  wrInterval('empty-task', '2026-07-02T12:00:00.000Z', '2026-07-02T12:05:00.000Z', null),
  wrInterval('named-task', '2026-07-02T12:06:00.000Z', '2026-07-02T12:10:00.000Z', '任务 A')
]).length === 2)
check('任务条展示真实时间范围', timeRangeLabel('2026-07-02T12:00:00.000Z', '2026-07-02T12:10:00.000Z') === '12:00–12:10')

// ---- focusDurations ----
const fr = (t, task) => ({ id: t, content: 'x', app: 'Code', task, createdAt: `2026-07-02T${t}` })
const fd = focusDurations([
  fr('09:00', '开发纸壳助手'),
  fr('09:05', '开发纸壳助手'),
  fr('09:10', '开发纸壳助手'), // 三条观察只各保留旧版一分钟估算，不补观察间隔
  fr('10:00', '写论文'), // 单条 = 60s
  fr('11:00', '开发纸壳助手') // 新段60s，累计240s
])
check('专注按任务累计且降序', fd[0].task === '开发纸壳助手' && fd[0].seconds === 240)
check('单条记录算 1 分钟', fd[1].task === '写论文' && fd[1].seconds === 60)
check('无 task 的记录不参与', focusDurations([{ ...fr('09:00', null) }]).length === 0)

// ---- normalizeTaskKey：折叠空格/全半角/大小写 ----
check('去空格', normalizeTaskKey('评审 EMNLP 论文') === normalizeTaskKey('评审EMNLP论文'))
check('全角折半角', normalizeTaskKey('评审ＥＭＮＬＰ论文') === normalizeTaskKey('评审EMNLP论文'))
check('大小写归一', normalizeTaskKey('emnlp') === normalizeTaskKey('EMNLP'))
check('去标点', normalizeTaskKey('论文阅读：2505.18966') === normalizeTaskKey('论文阅读 2505.18966'))
check('不同任务不误合', normalizeTaskKey('写论文') !== normalizeTaskKey('读论文'))
check('持久化任务标签统一全角与空白', normalizeTaskLabel('  评审ＥＭＮＬＰ  论文  ') === '评审EMNLP 论文')

// ---- focusDurations：仅空格差异的变体合并、桥接成一段、展示取更长写法 ----
const fdMerge = focusDurations([
  fr('09:00', '评审EMNLP论文'), // 无空格
  fr('09:05', '评审 EMNLP 论文') // 展示归组，但两条各计60s
])
check('空格变体合并为一个任务', fdMerge.length === 1)
check('合并后只累计实际观察回退时长，不把间隔计入', fdMerge[0].seconds === 120)
check('展示取更易读的空格写法', fdMerge[0].task === '评审 EMNLP 论文')

// ---- focusDurations：措辞漂移二级归并（包含关系 / 仅数字编号不同）----
const fdDrift = focusDurations([
  fr('09:00', '论文研读'),
  fr('09:05', '论文研读与标注'),
  fr('09:10', '论文阅读'),
  fr('09:12', '论文2505.18966阅读') // 数字词干相同 → 与「论文阅读」合并
])
check('包含关系的措辞漂移合并', fdDrift.filter((d) => d.task.includes('论文研读')).length === 1)
check('仅数字编号不同的写法合并', fdDrift.filter((d) => d.task.includes('阅读')).length === 1)
check('归并组暴露全部写法键', fdDrift.every((d) => Array.isArray(d.taskKeys) && d.taskKeys.length > 0))

// ---- focusDurations：泛化名（随心输入等）不参与统计 ----
const fdGeneric = focusDurations([fr('09:00', '随心输入'), fr('09:05', '写论文')])
check('泛化名不进入专注统计', fdGeneric.length === 1 && fdGeneric[0].task === '写论文')
check('isGenericFocusTask 折叠写法差异', isGenericFocusTask(' 随心 输入 ') && isGenericFocusTask('随便看看') && !isGenericFocusTask('写论文'))

// ---- isAppNameTask：裸 App/产品名不是任务 ----
check('自身产品名内置拒绝', isAppNameTask('谷子助手') && isAppNameTask(' GuziAssistant ') && isAppNameTask('Gooz'))
check('命中已知 App 名', isAppNameTask('微信', ['微信', 'ChatGPT']) && !isAppNameTask('写论文', ['微信']))
check('带动作的产品任务名不受影响', !isAppNameTask('开发谷子助手') && !isAppNameTask('微信需求讨论', ['微信']))

// ---- daySegmentOf ----
check('5 点=清晨', daySegmentOf('2026-07-02T05:00').label === '清晨')
check('8 点=上午（边界左闭）', daySegmentOf('2026-07-02T08:00').label === '上午')
check('13 点=中午', daySegmentOf('2026-07-02T13:59').label === '中午')
check('18 点=下午', daySegmentOf('2026-07-02T18:00').label === '下午')
check('23 点=晚间', daySegmentOf('2026-07-02T23:30').label === '晚间')
check('凌晨 2 点=深夜', daySegmentOf('2026-07-02T02:00').label === '深夜')

// ---- memoryToPlain / plainToMemory ----
check(
  '去要点符号与加粗',
  memoryToPlain('- **博士生**，研究`蛋白质设计`\n- 开发谷子助手') ===
    '博士生，研究蛋白质设计\n开发谷子助手'
)
check('去编号与标题符', memoryToPlain('# 画像\n1. 第一条\n2、第二条') === '画像\n第一条\n第二条')
check('纯文本原样', memoryToPlain('没有格式的一行') === '没有格式的一行')
check('纯文本 → 要点存储', plainToMemory('第一条\n\n第二条') === '- 第一条\n- 第二条')
check('已是要点不重复加', plainToMemory('- 已有要点') === '- 已有要点')
check(
  '往返一致',
  memoryToPlain(plainToMemory('身份 A\n项目 B')) === '身份 A\n项目 B'
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
