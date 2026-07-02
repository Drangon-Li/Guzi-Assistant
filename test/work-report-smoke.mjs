// 纯函数单测：工作日报 work-report + 屏幕扫描 work_summary 解析。运行：npm run test:workreport
import {
  dayKey,
  formatDuration,
  defaultReportTitle,
  splitTasksForDay,
  buildDailyReportPrompt,
  groupWorkPeriods,
  periodLabel,
  focusDurations
} from '../src/shared/work-report.ts'
import { parseWorkSummary, parseFocusTask } from '../src/shared/parsing.ts'

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
check('空素材各节标注（无）', (empty.text.match(/（无）/g) ?? []).length === 4)

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

// ---- focusDurations ----
const fr = (t, task) => ({ id: t, content: 'x', app: 'Code', task, createdAt: `2026-07-02T${t}` })
const fd = focusDurations([
  fr('09:00', '开发纸壳助手'),
  fr('09:05', '开发纸壳助手'),
  fr('09:10', '开发纸壳助手'), // 连续段 10min + 1min = 660s
  fr('10:00', '写论文'), // 单条 = 60s
  fr('11:00', '开发纸壳助手') // 间隔 >15min → 新段 60s，累计 720s
])
check('专注按任务累计且降序', fd[0].task === '开发纸壳助手' && fd[0].seconds === 720)
check('单条记录算 1 分钟', fd[1].task === '写论文' && fd[1].seconds === 60)
check('无 task 的记录不参与', focusDurations([{ ...fr('09:00', null) }]).length === 0)

// ---- parseFocusTask ----
check('focus_task 正常解析', parseFocusTask('{"items":[],"focus_task":"开发纸壳助手"}') === '开发纸壳助手')
check('focus_task 缺失 → null', parseFocusTask('{"items":[]}') === null)

// ---- parseWorkSummary ----
check('正常解析', parseWorkSummary('{"items":[],"work_summary":"在浏览器查资料"}') === '在浏览器查资料')
check('带前后噪声可解析', parseWorkSummary('前缀 {"items":[],"work_summary":"写代码"} 后缀') === '写代码')
check('null 值 → null', parseWorkSummary('{"items":[],"work_summary":null}') === null)
check('缺字段 → null', parseWorkSummary('{"items":[]}') === null)
check('空串 → null', parseWorkSummary('{"work_summary":"  "}') === null)
check('坏 JSON → null', parseWorkSummary('not json') === null)
check('超长截断到 200', parseWorkSummary(`{"work_summary":"${'长'.repeat(300)}"}`)?.length === 200)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
