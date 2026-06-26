// 纯函数单测：screen-foreground（前景过滤 / 时间解析 / 日期 / 候选窗口 / 选优）。
// 运行：node test/screen-foreground-smoke.mjs
import {
  foregroundLines,
  parseTimeOfDay,
  relWordDate,
  weekdayDate,
  combineDet,
  candidateWindows,
  pickBestByTime,
  buildClassifyPrompt,
  CLASSIFY_SYSTEM_PROMPT
} from '../src/shared/screen-foreground.ts'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) pass++
  else {
    fail++
    console.error('FAIL:', name)
  }
}
const NOW = new Date('2026-06-25T23:00:00') // 周四
const ymd = (o) => (o ? `${o.y}-${o.mo}-${o.d}` : null)
const hm = (o) => (o ? `${o.hh}:${o.mm}` : null)

// ---- foregroundLines：剔除左侧栏(x<0.18) + 菜单栏(y<0.025)，阅读顺序 ----
const boxes = [
  { text: '侧栏条目', x: 0.05, y: 0.3, w: 0.1, h: 0.02 },
  { text: '菜单栏时钟', x: 0.9, y: 0.005, w: 0.08, h: 0.02 },
  { text: '前景B', x: 0.5, y: 0.4, w: 0.1, h: 0.02 },
  { text: '前景A', x: 0.3, y: 0.4, w: 0.1, h: 0.02 },
  { text: '前景下一行', x: 0.3, y: 0.5, w: 0.1, h: 0.02 }
]
const fg = foregroundLines(boxes)
check('前景剔除左侧栏', !fg.join('\n').includes('侧栏条目'))
check('前景剔除菜单栏', !fg.join('\n').includes('菜单栏时钟'))
check('前景同带内按x排', fg[0] === '前景A  前景B')
check('前景跨带成多行', fg.length === 2 && fg[1] === '前景下一行')

// ---- parseTimeOfDay ----
check('下午四点=16:00', hm(parseTimeOfDay('明天下午四点开会')) === '16:0')
check('下午九点半=21:30', hm(parseTimeOfDay('下午九点半组会')) === '21:30')
check('HH:MM 直取', hm(parseTimeOfDay('9:30-11:30 笔试')) === '9:30')
check('中午=12:00', hm(parseTimeOfDay('中午吃饭')) === '12:0')
check('上午十点=10:00', hm(parseTimeOfDay('上午十点')) === '10:0')
check('无时间→null', parseTimeOfDay('开个会') === null)

// ---- relWordDate / weekdayDate ----
check('明天→6-26', ymd(relWordDate('明天开会', NOW)) === '2026-6-26')
check('后天→6-27', ymd(relWordDate('后天答辩', NOW)) === '2026-6-27')
check('昨天→6-24', ymd(relWordDate('昨天的会', NOW)) === '2026-6-24')
check('裸周X不被relWord认', relWordDate('周一交方案', NOW) === null)
check('下周一→6-29', ymd(weekdayDate('下周一交方案', NOW)) === '2026-6-29')

// ---- combineDet ----
check('明天下午六点→6-26T18:00', combineDet('shilong明天下午六点来c9872开会', NOW) === '2026-06-26T18:00')
check('区间取末日(选课至7/3)', combineDet('选课时间：2026年6月15日（星期一）12:00至2026年7月3日（星期五）12:00', NOW) === '2026-07-03T12:00')
check('过去X月X日不+1年', combineDet('博资考笔试时间统一为：6月11日9:30-11:30', NOW) === '2026-06-11T09:30')
check('只有日期→T00:00', combineDet('开题答辩7月14日', NOW) === '2026-07-14T00:00')
check('无日期→null', combineDet('随便聊聊', NOW) === null)

// ---- candidateWindows ----
const lines1 = ['【A类活动预告】主题：AI', '时间：6月28日14:00-16:15', '主讲人：李斯特']
check('标题在上行也成候选', candidateWindows(lines1).length === 1)
check('日期但无事件词→不成候选', candidateWindows(['◎5月22日', '培养部学生培养']).length === 0)
check('事件词但无日期→不成候选', candidateWindows(['组会开得很顺利', '大家辛苦']).length === 0)
const cw = candidateWindows(['李世龙', '明天下午四点去c9821开会'])
check('日期+事件词→候选', cw.length === 1 && cw[0].detW.includes('c9821'))

// ---- pickBestByTime ----
const mk = (iso, conf) => ({ title: 't', isoTime: iso, deadline: false, belongsToUser: 'yes', hits: [], confidence: conf, needsVlm: false, strong: iso !== null })
check(
  '优先有具体时间的候选',
  pickBestByTime([mk('2026-06-23T00:00', 0.95), mk('2026-07-03T12:00', 0.6)])?.isoTime === '2026-07-03T12:00'
)
check('空→null', pickBestByTime([]) === null)

// ---- prompt ----
check('分类提示词含拒列表项/讨论', /列表项|讨论|个人看法/.test(CLASSIFY_SYSTEM_PROMPT))
check('分类 prompt 含自称', buildClassifyPrompt('明天开会', ['李世龙']).includes('李世龙'))
check('分类 prompt 含待判文字', buildClassifyPrompt('明天开会', []).includes('明天开会'))

console.log(`screen-foreground-smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
