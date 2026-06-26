// 纯函数单测：screen-foreground（前景过滤 / 时间解析 / 日期 / 候选窗口 / 选优）。
// 运行：node test/screen-foreground-smoke.mjs
import {
  foregroundLines,
  foregroundBands,
  parseTimeOfDay,
  relWordDate,
  weekdayDate,
  combineDet,
  candidateWindows,
  pickBestByTime,
  buildClassifyPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  isAmbiguous,
  chatSentDateKey,
  messageTimestamps,
  isStaleMessage
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

check('foregroundBands 带 y 坐标', foregroundBands(boxes).length === 2 && typeof foregroundBands(boxes)[0].y === 'number')

// ---- #2 消息新旧：chatSentDateKey / messageTimestamps / isStaleMessage（NOW=2026-06-25 周四）----
check('纯时刻=今天', chatSentDateKey('上午 11:05', NOW) === '2026-06-25')
check('昨天 14:09=昨天', chatSentDateKey('昨天 14:09', NOW) === '2026-06-24')
check('X月X日带时刻', chatSentDateKey('6月20日 周五 下午4:29', NOW) === '2026-06-20')
check('无时刻→非时间戳', chatSentDateKey('随便聊聊没有时间', NOW) === null)
const tsBoxes = [
  { text: '上午 11:05', x: 0.45, y: 0.2, w: 0.1, h: 0.02 }, // 居中→时间戳(今天)
  { text: '昨天 14:09', x: 0.46, y: 0.5, w: 0.1, h: 0.02 }, // 居中→时间戳(昨天)
  { text: '明天下午四点开会', x: 0.6, y: 0.6, w: 0.3, h: 0.02 } // 右气泡(cx=0.75)→非时间戳
]
const ts = messageTimestamps(tsBoxes, NOW)
check('只取居中时间戳', ts.length === 2)
check('时间戳按 y 升序', ts[0].y < ts[1].y)
check('候选在昨天戳下方→旧', isStaleMessage(0.55, ts, NOW) === true)
check('候选在今天戳下方→不旧', isStaleMessage(0.3, ts, NOW) === false)
check('无时间戳→不旧', isStaleMessage(0.5, [], NOW) === false)

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
// #2 时间二次错：日期前的聊天时间戳(18:40)不应压过本行「下午四点」
check('忽略日期前的聊天时间戳', combineDet('李世龙 18:40 明天下午四点开会', NOW) === '2026-06-26T16:00')
check('区间起始时间不绑到末日', combineDet('选课6月15日14:00至7月3日', NOW) === '2026-07-03T00:00')

// ---- candidateWindows ----
const lines1 = ['【A类活动预告】主题：AI', '时间：6月28日14:00-16:15', '主讲人：李斯特']
check('标题在上行也成候选', candidateWindows(lines1).length === 1)
check('日期但无事件词→不成候选', candidateWindows(['◎5月22日', '培养部学生培养']).length === 0)
check('事件词但无日期→不成候选', candidateWindows(['组会开得很顺利', '大家辛苦']).length === 0)
const cw = candidateWindows(['李世龙', '明天下午四点去c9821开会'])
check('日期+事件词→候选', cw.length === 1 && cw[0].detW.includes('c9821'))
// deadline 动词("X点之前完成…")也应成候选（修漏检）
const cw3 = candidateWindows(['老板', '明天下午三点之前完成公司的通讯稿'])
check('截止动词「完成」成候选', cw3.length === 1 && cw3[0].detW.includes('完成'))
check('「交付」成候选', candidateWindows(['周五前交付设计稿']).length === 1)

// ---- pickBestByTime ----
const mk = (iso, conf) => ({ title: 't', isoTime: iso, deadline: false, belongsToUser: 'yes', hits: [], confidence: conf, needsVlm: false, strong: iso !== null })
check(
  '优先有具体时间的候选',
  pickBestByTime([mk('2026-06-23T00:00', 0.95), mk('2026-07-03T12:00', 0.6)])?.isoTime === '2026-07-03T12:00'
)
check('空→null', pickBestByTime([]) === null)

// ---- isAmbiguous：多 strong 候选日期打架 → 升级 VLM ----
check('单候选→不歧义', isAmbiguous([mk('2026-06-26T18:00', 0.9)]) === false)
check('同日多候选→不歧义', isAmbiguous([mk('2026-06-26T18:00', 0.9), mk('2026-06-26T09:00', 0.8)]) === false)
check('异日多 strong→歧义', isAmbiguous([mk('2026-06-23T00:00', 0.9), mk('2026-07-03T12:00', 0.85)]) === true)
check('弱候选(无日期)不计入', isAmbiguous([mk('2026-06-26T18:00', 0.9), mk(null, 0.8)]) === false)
check('空→不歧义', isAmbiguous([]) === false)

// ---- prompt ----
check('分类提示词含拒列表项/讨论', /列表项|讨论|个人看法/.test(CLASSIFY_SYSTEM_PROMPT))
check('分类 prompt 含自称', buildClassifyPrompt('明天开会', ['李世龙']).includes('李世龙'))
check('分类 prompt 含待判文字', buildClassifyPrompt('明天开会', []).includes('明天开会'))

console.log(`screen-foreground-smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
