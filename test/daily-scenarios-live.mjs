// 日常场景端到端解析：不同时间表述 × @不同成员 × 不同来源渠道，跑生产代码看「能不能自己解析对」。
//
// 走的是生产模块本身：提示词（buildInstructions + HINTS）、模型客户端、解析规整、捕获入库分流
// （capture.ts 里的 parseAndStore / createTasksFromItems / extractFromFile 原样抽出）、IPC 注册包装与
// tasks:quick-add / assistant:chat handler、飞书 handleMessage（假 SDK）、屏幕 OCR 的「谁说的」转写与入队判定、
// 真实 SQLite 任务表 + 提醒调度。只把 Electron 窗口、原生截屏/OCR、剪切板换成桩——测试绝不读剪切板和屏幕。
//
// 不是 *-smoke.mjs：npm test 永远不会发起付费请求。
// 离线装配校验（不联网，假模型按期望回放）：
//   npm run test:scenarios
// 真实模型（config 只含 apiBase/apiKey/model[/apiFormat/modelChat/modelVision]，chmod 600）：
//   npm run test:scenarios -- --run --config <path> [--out report.json] [--only 关键词]
// （better-sqlite3 按 Electron ABI 编译，所以用 Electron 自带的 Node 跑；CI 重编给 Node 时直接 node 也行。）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { posix, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const ts = require('typescript')
const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const live = args.includes('--run')
const only = option('--only')
for (const arg of args.filter((a) => a.startsWith('--')))
  assert.ok(['--run', '--config', '--out', '--only'].includes(arg), `unknown option ${arg}`)

const KEY = '__guziDailyScenarios'
const temp = mkdtempSync(join(tmpdir(), 'guzi-daily-'))
const state = (globalThis[KEY] = {
  temp,
  db: null,
  handlers: new Map(),
  profile: null,
  settings: {
    useCustomModel: true, apiBase: 'https://offline.invalid/v1', apiKey: 'offline', model: 'offline-fake',
    modelVision: '', modelChat: '', apiFormat: 'openai-chat',
    feishuAppId: 'cli_test_app', feishuAppSecret: 'test_secret',
    taskReminderEnabled: true, taskReminderOffsetMin: 5
  },
  parsed: [], // 每次 parseToItems 的结果，按调用顺序
  previews: [],
  reminders: [],
  petSays: [],
  lark: { replies: [], handlers: null, started: false, loaded: false }
})

// ---------- 时间：全部相对「现在」计算，任何一天跑都成立 ----------
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const dayOf = (offset) => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return ymd(d) }
const CN = ['日', '一', '二', '三', '四', '五', '六', '日']
const dow = now.getDay() || 7 // 周一=1 … 周日=7
/** 最近的周 X：本周还没过就说「本周X」，过了就说「下周X」，避免跑测那天的歧义。 */
const upcoming = (x) => (x > dow ? { word: `本周${CN[x]}`, date: dayOf(x - dow) } : { word: `下周${CN[x]}`, date: dayOf(7 - dow + x) })
const nextWeek = (x) => ({ word: `下周${CN[x]}`, date: dayOf(7 - dow + x) })
const monthEnd = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0))
const nextDate = (m, d) => {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const y = new Date(now.getFullYear(), m - 1, d) < today ? now.getFullYear() + 1 : now.getFullYear()
  return `${y}-${pad(m)}-${pad(d)}`
}
const nextDayOfMonth = (d) => {
  const c = new Date(now.getFullYear(), now.getMonth(), d)
  if (c.getDate() <= now.getDate() && c.getMonth() === now.getMonth()) c.setMonth(c.getMonth() + 1)
  return ymd(c)
}
const md = (date) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
const inMinutes = (min) => new Date(now.getTime() + min * 60_000)
const TODAY = dayOf(0)
const TOMORROW = dayOf(1)
const AFTER_TOMORROW = dayOf(2)
const fri = upcoming(5)
const thu = upcoming(4)
const sun = upcoming(7)
const nextMon = nextWeek(1)
const nextTue = nextWeek(2)
const nextWed = nextWeek(3)
const nextFri = nextWeek(5)
const jan8 = nextDate(1, 8)
const day20 = nextDayOfMonth(20)
const day15 = nextDayOfMonth(15)
const twoHours = inMinutes(120)
const threeMin = inMinutes(3)
const yesterday = dayOf(-1)

// ---------- 两个用户档案：职场 / 学生 ----------
const WORKER = { name: '林小谷', nicknames: ['小谷', 'Gugu'], accounts: ['lin.xg'], identity: 'worker', org: '星河科技', group: '产品研发部·前端组', workHours: '09:30-18:30', confirmMode: 'standard', belongingNotMine: [] }
const STUDENT = { name: '张三', nicknames: ['三儿'], accounts: ['zhangsan99'], identity: 'student', org: '北航', group: '数据挖掘课题组', workHours: '', confirmMode: 'standard', belongingNotMine: [] }

// ---------- 场景 ----------
// expect: 应该出现的条目（title 正则命中即认领），可检查 belongs / when(=start??due) / whenDate / near(±分钟) / notAdd / location / notes / field；optional=可不出现，出现就要符合
// others: 命中这些正则的条目若存在，归属必须是 no（不能算到用户头上）
// none: 一条都不该提取；noYes: 可以有条目，但不能有「本人 + 直接 add」
const SCENARIOS = [
  // —— 剪切板：职场群聊 ——
  { id: 'clip-group-mixed', channel: 'clipboard', profile: WORKER, title: '群聊：@本人评审 + @他人用例 + @所有人周报',
    text: `【星河科技·前端组】\n张薇：@林小谷 明天下午3点到 5F 会议室评审首页改版方案，记得带上交互稿\n张薇：@王磊 今天下班前补完登录模块的测试用例\n张薇：@所有人 ${fri.word}18:00前提交本周周报`,
    expect: [
      { title: /评审/, belongs: 'yes', when: `${TOMORROW}T15:00`, location: /5F|会议室/ },
      { title: /周报/, belongs: 'uncertain', when: `${fri.date}T18:00`, notAdd: true }
    ],
    others: [/测试用例/] },
  { id: 'clip-nickname-meeting', channel: 'clipboard', profile: WORKER, title: '英文昵称 @Gugu + 下周三 + 线上会议号',
    text: `@Gugu ${nextWed.word}上午10点半和客户开需求对齐会，腾讯会议 618-332-905，提前把原型链接发一下群里`,
    expect: [{ title: /对齐|需求|客户/, belongs: 'yes', when: `${nextWed.date}T10:30`, location: /腾讯会议|618/ }] },
  { id: 'clip-account-review', channel: 'clipboard', profile: WORKER, title: '账号名 lin.xg 被指派 code review + 后天中午',
    text: `[GitLab] 陈晨 requested your review on !482 "feat: 首页骨架屏"\nReviewer: @lin.xg\n备注：后天中午12点前帮忙过一下，周四要合进 release 分支`,
    expect: [{ title: /review|评审|482|骨架屏|代码/i, belongs: 'yes', when: `${AFTER_TOMORROW}T12:00` }] },
  { id: 'clip-host-standup', channel: 'clipboard', profile: WORKER, title: '他人请假、本人代主持站会',
    text: `王磊：明天上午我去医院体检，请半天假～\n张薇：好的。@林小谷 那明天 9:30 的站会你来主持一下`,
    expect: [{ title: /站会|主持/, belongs: 'yes', when: `${TOMORROW}T09:30` }],
    others: [/体检|请假/] },
  { id: 'clip-ad', channel: 'clipboard', profile: WORKER, title: '营销广告不生成任务',
    text: '【限时福利】双十一会员 5 折，仅剩 3 天！点击 t.cn/xxxx 立即领取，退订回 T', none: true },
  { id: 'clip-rescheduled', channel: 'clipboard', profile: WORKER, title: '会议改期：只认新时间',
    text: `【通知】原定今天下午4点的项目周会改到明天上午11点，地点不变（3F 大会议室）。@林小谷 @陈晨 请准时参加`,
    expect: [{ title: /周会|会议/, belongs: 'yes', when: `${TOMORROW}T11:00` }],
    forbidWhen: [`${TODAY}T16:00`] },
  { id: 'clip-already-done', channel: 'clipboard', profile: WORKER, title: '已经办完的事不再提醒',
    text: '财务小刘：@林小谷 你上周的发票报销我已经帮你提交审批了，不用再弄了哈', noYes: true },
  { id: 'clip-soft-ask', channel: 'clipboard', profile: WORKER, title: '委婉、无时限的点名请求',
    text: '设计-周周：@林小谷 有空帮忙看下新版图标稿，不急，什么时候看都行', expect: [{ title: /图标|设计稿|看/, belongs: 'yes', notAdd: true }] },
  { id: 'clip-cross-year', channel: 'clipboard', profile: WORKER, title: '跨年日期：1月8日',
    text: 'HRBP：@林小谷 年度述职材料请在1月8日前发给我，模板见附件', expect: [{ title: /述职/, belongs: 'yes', whenDate: jan8, field: 'due' }] },
  { id: 'clip-tonight', channel: 'clipboard', profile: WORKER, title: '只叫昵称不@ + 今晚8点前',
    text: '小谷，今晚8点前把上线 checklist 发群里，我们9点开始发版', expect: [{ title: /checklist|清单|上线/i, belongs: 'yes', when: `${TODAY}T20:00` }] },
  { id: 'clip-month-end', channel: 'clipboard', profile: WORKER, title: '@所有人 + 月底前',
    text: '行政：@所有人 本月底前请在 OA 上完成年假登记，逾期视为放弃', expect: [{ title: /年假/, belongs: 'uncertain', whenDate: monthEnd, notAdd: true }] },
  { id: 'clip-three-way-split', channel: 'clipboard', profile: WORKER, title: '三人分工只认自己那份',
    text: `张薇：这期迭代分工——@陈晨 负责接口文档，@林小谷 负责前后端联调，@王磊 负责压测。${thu.word}下午6点前各自同步进度`,
    expect: [{ title: /联调/, belongs: 'yes' }], others: [/接口文档/, /压测/] },
  // —— 剪切板：学生 ——
  { id: 'clip-student-course', channel: 'clipboard', profile: STUDENT, title: '课程群 @本人 下周一展示',
    text: `助教：@张三 你们组的期中展示排在${nextMon.word}下午2点，记得提前一天把 PPT 发我邮箱`,
    expect: [{ title: /展示|PPT/i, belongs: 'yes', whenDate: nextMon.date }] },
  { id: 'clip-student-exam', channel: 'clipboard', profile: STUDENT, title: '教务考试安排（地点 + 注意事项）',
    text: '【教务处】数据挖掘课程期末考试定于12月28日 14:00-16:00 在主M402 进行，闭卷，请携带学生证，开考15分钟后不得入场。',
    expect: [{ title: /考试|期末/, when: `${nextDate(12, 28)}T14:00`, location: /M402/, notes: /学生证|15/ }] },
  { id: 'clip-parcel', channel: 'clipboard', profile: STUDENT, title: '快递短信：明天18点前取件',
    text: '【菜鸟驿站】您的快递已到北航东区驿站，取件码 6-2-3018，请于明天18:00前取件，超时将退回。',
    expect: [{ title: /取|快递|驿站/, belongs: 'yes', when: `${TOMORROW}T18:00` }] },
  { id: 'clip-advisor-meeting', channel: 'clipboard', profile: STUDENT, title: '导师 @所有人 组会 + 点名三儿汇报',
    text: `【数据挖掘课题组】王老师：@所有人 ${upcoming(5).word}下午3点组会，A301。三儿这次汇报一下实验进展，李雷准备文献分享。`,
    expect: [
      { title: /汇报|实验/, belongs: 'yes', when: `${upcoming(5).date}T15:00` },
      { title: /^(?!.*汇报).*组会/, optional: true, belongs: 'uncertain', notAdd: true } // 模型有时把组会单列，单列时必须待确认
    ], others: [/文献/] },
  // —— 日程页悬浮「+」自然语言快建（tasks:quick-add，用户亲手输入，强制归属本人） ——
  { id: 'quick-call-mom', channel: 'quick-add', profile: WORKER, title: '明早9点', text: '明早9点给妈妈打电话',
    expect: [{ title: /妈妈|电话/, when: `${TOMORROW}T09:00` }] },
  { id: 'quick-dinner', channel: 'quick-add', profile: WORKER, title: '下周五晚7点半 + 地点', text: `${nextFri.word}晚上7点半和大学室友聚餐，海底捞五道口店`,
    expect: [{ title: /聚餐|室友/, when: `${nextFri.date}T19:30`, location: /海底捞/ }] },
  { id: 'quick-relative', channel: 'quick-add', profile: WORKER, title: '相对时间：两小时后', text: '两小时后提醒我去取外卖',
    expect: [{ title: /外卖/, near: twoHours, toleranceMin: 10 }] },
  { id: 'quick-rent', channel: 'quick-add', profile: WORKER, title: '每月15号（取最近一次）', text: '每月15号交房租',
    expect: [{ title: /房租/, whenDate: day15 }] },
  { id: 'quick-hospital', channel: 'quick-add', profile: WORKER, title: '周日上午 + 注意事项', text: `${sun.word}上午十点去医院复查，记得带上病历本和医保卡`,
    expect: [{ title: /复查|医院/, when: `${sun.date}T10:00`, notes: /病历|医保/ }] },
  { id: 'quick-standup-soon', channel: 'quick-add', profile: WORKER, title: '3 分钟后（给提醒链路用）', text: `${hm(threeMin)} 开临时站会`,
    expect: [{ title: /站会/, when: `${ymd(threeMin)}T${hm(threeMin)}` }] },
  // —— 快捷提问条（assistant:chat） ——
  { id: 'chat-dentist', channel: 'assistant-chat', profile: WORKER, title: '对话里让助手记事', text: `帮我记一下：${nextTue.word}上午9点牙科复诊`,
    expect: [{ title: /牙|复诊/, when: `${nextTue.date}T09:00` }] },
  // —— 飞书私聊机器人（假 SDK，真 handleMessage） ——
  { id: 'feishu-text', channel: 'feishu', profile: WORKER, title: '飞书私聊：粘贴的群消息带「@林小谷」文本',
    feishu: { message_type: 'text', text: `张薇：@林小谷 ${md(AFTER_TOMORROW)}上午10点前把埋点方案发我` },
    expect: [{ title: /埋点/, belongs: 'yes', when: `${AFTER_TOMORROW}T10:00` }] },
  { id: 'feishu-post', channel: 'feishu', profile: WORKER, title: '飞书富文本：标题 + 多人分工',
    feishu: { message_type: 'post', mentions: [{ key: '@_user_1', name: '林小谷' }, { key: '@_user_2', name: '陈晨' }],
      post: { title: '周四发版安排', content: [[{ tag: 'text', text: '前端：' }, { tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' 负责灰度开关配置' }],
        [{ tag: 'text', text: '后端：' }, { tag: 'at', user_id: '@_user_2' }, { tag: 'text', text: ` 负责数据迁移；时间：${thu.word}晚上8点开始` }]] } },
    sawInput: /@林小谷 负责灰度/,
    expect: [{ title: /灰度|开关/, belongs: 'yes' }], others: [/数据迁移/] },
  { id: 'feishu-mention-placeholder', channel: 'feishu', profile: WORKER, title: '飞书原生 @（@_user_1 占位）',
    feishu: { message_type: 'text', text: '@_user_1 明天下午两点来3楼会议室过一下Q4规划', mentions: [{ key: '@_user_1', name: '林小谷' }] },
    expect: [{ title: /Q4|规划/, belongs: 'yes', when: `${TOMORROW}T14:00` }], sawInput: /^@林小谷 明天/ },
  // —— 屏幕感知 OCR（真实「谁说的」转写 + 入队判定） ——
  { id: 'screen-chat', channel: 'screen', profile: WORKER, title: '聊天窗口：今天 @本人 + 昨天旧消息 + 侧边栏噪声',
    boxes: [
      ['消息', 0.01, 0.08, 0.08], ['通讯录', 0.01, 0.13, 0.08], ['日历', 0.01, 0.18, 0.08],
      ['昨天 18:40', 0.44, 0.22, 0.12], ['王磊：周报已交，大家辛苦', 0.14, 0.27, 0.3],
      ['今天 10:12', 0.44, 0.40, 0.12], ['张薇：@林小谷 今天下午5点前把埋点评审意见发我', 0.14, 0.45, 0.36],
      ['好的，我下午弄', 0.66, 0.52, 0.2], ['陈晨：我这边的接口明天上午给', 0.14, 0.60, 0.32]
    ],
    expect: [{ title: /埋点|评审意见/, belongs: 'yes', when: `${TODAY}T17:00`, queued: true }], others: [/周报/] },
  { id: 'screen-own-work', channel: 'screen', profile: WORKER, title: '自己在写代码/敲命令：不生成任务',
    boxes: [['src/main/parser.ts — guzi-assistant', 0.2, 0.02, 0.5], ['export async function parseToItems(input) {', 0.1, 0.2, 0.5],
      ['// TODO: 明天把超时改成 60 秒', 0.1, 0.25, 0.45], ['$ npm test -- --watch', 0.1, 0.8, 0.3], ['89/89 通过', 0.1, 0.85, 0.2]],
    noQueue: true },
  { id: 'screen-mail', channel: 'screen', profile: WORKER, title: '邮件客户端：面试官安排',
    boxes: [['收件箱 (12)', 0.01, 0.1, 0.12], ['主题：面试安排确认', 0.3, 0.1, 0.4], ['发件人：HR 李婷', 0.3, 0.15, 0.3],
      [`林小谷您好，请您作为面试官参加 ${md(nextWed.date)} 14:00 的前端候选人面试，地点 6F 如意厅。`, 0.3, 0.25, 0.62]],
    expect: [{ title: /面试/, belongs: 'yes', when: `${nextWed.date}T14:00`, location: /如意厅|6F/, queued: true }] },
  // —— 拖入 Word 文档（真实 mammoth 懒加载） ——
  { id: 'file-docx-minutes', channel: 'docx', profile: WORKER, title: 'Word 会议纪要：三条行动项',
    lines: ['迭代复盘会议纪要', `日期：${TODAY}`, '参会：张薇、林小谷、陈晨、王磊', '行动项：',
      `1. 林小谷：${md(day20)}前完成登录页改版`, `2. 陈晨：${nextTue.word}前补齐接口文档`, `3. 全员：${fri.word}下午4点参加复盘会，地点 3F`],
    expect: [{ title: /登录页|改版/, belongs: 'yes', whenDate: day20 }, { title: /复盘/, when: `${fri.date}T16:00` }], others: [/接口文档/] },
  // —— 会议转录（voice_note 提示词） ——
  { id: 'voice-meeting', channel: 'voice', profile: WORKER, title: '口语转录：中途推翻的决定 + 认领',
    text: '张薇：那个压测我们先排王磊……算了压测这期先不做了。埋点的事谁跟一下？林小谷：这个我来吧。张薇：好，那小谷你下周一给我个结论。陈晨你把接口文档周三前更新一下。',
    expect: [{ title: /埋点/, belongs: 'yes', whenDate: nextMon.date }], others: [/接口文档/], forbidTitle: [/压测/] }
]

// ---------- 装配生产模块（只替换 Electron/原生/窗口） ----------
function declarations(file, names) {
  const source = readFileSync(join(root, file), 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const picked = sf.statements.filter((n) =>
    (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) ||
    (ts.isVariableStatement(n) && n.declarationList.declarations.some((d) => names.includes(d.name.getText(sf)))))
  assert.equal(picked.length, names.length, `${file} 的生产声明变了，测试需要同步：${names.join(',')}`)
  return picked.map((n) => n.getText(sf)).join('\n')
}
const S = `globalThis.${KEY}`
const stubs = {
  electron: `const s=${S};
    const forbid=(n)=>new Proxy({},{get:(_,p)=>{throw new Error('测试禁止触碰 electron.'+n+'.'+String(p))}});
    export const ipcMain={handle:(c,f)=>{assert(!s.handlers.has(c),'重复注册 '+c);s.handlers.set(c,f)},on:(c,f)=>s.handlers.set(c,f),removeHandler:(c)=>s.handlers.delete(c)};
    function assert(ok,m){if(!ok)throw new Error(m)}
    export const app={getPath:()=>s.temp,getAppPath:()=>s.temp,isPackaged:false,getVersion:()=>'0.0.0-test',on(){},quit(){},exit(){}};
    export const BrowserWindow={getAllWindows:()=>[]};
    export class Notification{static isSupported(){return false}}
    export const powerMonitor={on(){},removeListener(){}};
    export const nativeImage=forbid('nativeImage'); export const clipboard=forbid('clipboard');
    export const screen=forbid('screen'); export const dialog=forbid('dialog'); export const shell=forbid('shell');`,
  '@larksuiteoapi/node-sdk': `const s=${S}.lark; s.loaded=true;
    export class Client{constructor(o){this.opts=o;this.auth={v3:{tenantAccessToken:{internal:async()=>({code:0})}}};
      this.im={v1:{message:{create:async({data})=>{s.replies.push(JSON.parse(data.content).text)}},messageResource:{get:async()=>{throw new Error('本测试不下载图片')}}}}}}
    export class EventDispatcher{register(h){s.handlers=h;return this}}
    export class WSClient{start(){s.started=true}}
    export const LoggerLevel={error:'error'};`,
  'src/main/db/connection.ts': `export const getDb=()=>${S}.db; export const isFtsReady=()=>false;`,
  'src/main/db.ts': `export * from './db/tasks.ts'; export * from './db/sources.ts'; export * from './db/detections.ts';
    const s=${S};
    export const getProfile=()=>s.profile; export const saveProfile=(p)=>{s.profile=p};
    export const getSettings=()=>s.settings; export const personalMemoryText=()=>'';
    export const listChatMessages=()=>[]; export const saveChatMessages=()=>{}; export const clearChatMessages=()=>{};`,
  'src/main/session.ts': `export const getSession=()=>({functionsBase:'',token:null});`,
  'src/main/windows.ts': `const s=${S};
    export const broadcast=()=>{}; export const broadcastExcept=()=>{}; export const debugEvent=()=>{};
    export const showPreview=(p)=>s.previews.push(p); export const focusMain=()=>{}; export const getExitWindows=()=>[]; export const appState={quitting:false};`,
  'src/main/shotvault.ts': 'export const deleteShot=()=>{}; export const finalizeShot=()=>{};',
  'src/main/export.ts': 'export const exportTaskIcs=()=>null;',
  'src/main/quickbar.ts': 'export const isQuickBarVisible=()=>true;',
  'src/main/reminder-window.ts': `const s=${S}; export const showReminders=(p)=>s.reminders.push(p); export const hideReminderWindow=()=>{}; export const resizeReminder=()=>{};`,
  'src/main/pet/controller.ts': `const s=${S}; export const applyExternalPetReaction=()=>{}; export const applyExternalPetSay=(t)=>s.petSays.push(t);
    export const clearPetPersistentSay=()=>{}; export const applyPetPersistentSay=(t)=>s.petSays.push(t);`,
  'src/main/plugins/index.ts': 'export const assistantActions=()=>""; export const assistantContext=()=>""; export const runAssistantAction=()=>null;',
  // capture.ts 整体依赖原生截屏/OCR，这里原样抽出与本测试相关的生产声明，再补齐它们用到的 import。
  'src/main/capture.ts': `import { readFileSync } from 'fs'
    import { basename, extname } from 'path'
    import { redactSensitive } from '@shared/sensitive'
    import { createSource, deleteSourceRow, findDuplicateTitle, getProfile } from './db'
    import { createTaskFromItem, scheduledStatus } from './task-ingest'
    import { parseToItems as productionParse } from './parser'
    import { broadcast } from './windows'
    import { assertContentEpoch, captureContentEpoch, isContentEpochCurrent, isExitPreparing, trackContentWork } from './content-lifecycle.ts'
    const parseToItems = async (input) => { const items = await productionParse(input); ${S}.parsed.push({ input, items }); return items }
    const nativeImage = new Proxy({}, { get: () => { throw new Error('本测试不处理图片') } })
    const pdfParse = () => { throw new Error('本测试不处理 PDF') }
    export const toJpegDataUrl = () => { throw new Error('本测试不处理图片') }
    ${declarations('src/main/capture.ts', ['IMAGE_EXTS', 'TEXT_EXTS', 'excerptOf', 'emptyParseSummary', 'extractFromFile',
      'LIST_EXTRACTION_RULES', 'SCREEN_LIST_EXTRACTION_RULES', 'SCREEN_NOT_SCHEDULE_RULES', 'HINTS', 'createTasksFromItems',
      'parseAndStore', 'parseAndStoreInternal', 'submitFeishu', 'MAX_FILES_PER_SUBMIT', 'submitFiles', 'submitFilesInternal'])}
    export { parseAndStore }`,
  // 屏幕感知：OCR 框 → 「谁说的」转写，用生产的 buildOcrText
  'src/main/screen-text.ts': `import { looksLikeChat, clusterChatSpeakers, formatChatTranscript } from '@shared/chat-layout'
    ${declarations('src/main/screenwatch.ts', ['buildOcrText'])}
    export { buildOcrText }`
}
const REAL_MAIN = new Set(['src/main/parser.ts', 'src/main/model-client.ts', 'src/main/task-ingest.ts', 'src/main/db/tasks.ts',
  'src/main/db/sources.ts', 'src/main/db/detections.ts', 'src/main/db-migrations.ts', 'src/main/content-lifecycle.ts', 'src/main/content-ipc.ts',
  'src/main/exit-lifecycle.ts', 'src/main/feishu.ts', 'src/main/ipc/register.ts', 'src/main/ipc/task.ts', 'src/main/assistant.ts',
  'src/main/detection-cards.ts', 'src/main/task-reminder.ts'])
const compiled = new Set()
const out = (name) => join(temp, 'mod', name.startsWith('src/') ? name.replace(/\.ts$/, '.mjs') : `${name.replace(/[^a-z0-9]/gi, '_')}.mjs`)
function compile(name) {
  if (compiled.has(name)) return
  compiled.add(name)
  assert.ok(name in stubs || name.startsWith('src/shared/') || REAL_MAIN.has(name), `未声明的生产依赖：${name}`)
  const res = ts.transpileModule(stubs[name] ?? readFileSync(join(root, name), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true, fileName: name
  })
  const code = res.outputText.replace(/((?:from\s*|import\s*\(\s*)['"])([^'"]+)(['"])/g, (whole, before, spec, after) => {
    if (spec in stubs && !spec.startsWith('src/')) { compile(spec); return before + pathToFileURL(out(spec)).href + after }
    if (!spec.startsWith('.') && !spec.startsWith('@shared/')) {
      if (spec.startsWith('node:') || ['fs', 'path', 'crypto', 'os', 'url', 'events'].includes(spec)) return whole
      return before + pathToFileURL(require.resolve(spec)).href + after // better-sqlite3 / mammoth：项目里的真实依赖
    }
    const base = name.startsWith('src/') ? name : 'src/main/x.ts'
    let target = spec.startsWith('@shared/') ? `src/shared/${spec.slice(8)}` : posix.resolve('/', posix.dirname(base), spec).slice(1)
    if (!target.endsWith('.ts')) target += '.ts'
    compile(target)
    return before + pathToFileURL(out(target)).href + after
  })
  mkdirSync(dirname(out(name)), { recursive: true })
  writeFileSync(out(name), code)
}
const load = (name) => { compile(name); return import(pathToFileURL(out(name)).href) }

// ---------- 模型：真实端点或离线回放 ----------
let currentFake = null
const originalFetch = globalThis.fetch
let realFetch = null
globalThis.fetch = async (url, init) => {
  if (realFetch) return realFetch(url, init)
  assert.ok(currentFake, '离线模式下出现了未预期的模型请求')
  const text = currentFake(JSON.parse(init.body))
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}
/** 离线回放：按期望构造「理想」输出，只为把下游入库/提醒链路在不联网时也跑一遍。 */
function idealOutput(sc, wrap) {
  const items = (sc.expect ?? []).map((e) => {
    const when = e.when ?? (e.whenDate ? `${e.whenDate}T23:59` : e.near ? `${ymd(e.near)}T${hm(e.near)}` : null)
    const sample = e.title.source.split('|')[0].replace(/[\\()[\]^$]/g, '')
    return { title: `${sample}（离线样例）`, item_type: e.field === 'due' ? 'deadline' : 'meeting', belongs_to_user: e.belongs ?? 'yes',
      belonging_reason: '离线回放', user_role: 'owner', start_time: e.field === 'due' ? null : when, due_time: e.field === 'due' ? when : null,
      location: e.location ? '5F 会议室 腾讯会议 618 海底捞 M402 如意厅 6F 3F' : null, priority: e.notAdd ? 'low' : 'medium',
      confidence: e.belongs === 'uncertain' ? 0.6 : 0.9, suggested_action: e.notAdd ? 'confirm' : 'add',
      notes: e.notes ? ['带上学生证、病历本和医保卡，开考15分钟后不得入场'] : [], evidence: [], duplicate_of: null, tags: [] }
  })
  return wrap === 'assistant' ? JSON.stringify({ reply: '已帮你记下', candidates: items, add: items.map((_, i) => ({ source: 'current', candidate: i + 1 })) })
    : JSON.stringify({ items })
}

// ---------- 检查 ----------
const eventOf = (i) => i.start_time ?? i.due_time ?? i.startTime ?? i.dueTime ?? null
const norm = (i) => ({ title: i.title, belongs: i.belongs_to_user ?? i.belongsToUser, when: eventOf(i), start: i.start_time ?? i.startTime ?? null,
  due: i.due_time ?? i.dueTime ?? null, action: i.suggested_action ?? i.suggestedAction, location: i.location ?? null, notes: i.notes ?? [], priority: i.priority })
function judge(sc, items, extra = {}) {
  const rows = items.map(norm)
  const checks = []
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, ...(detail ? { detail } : {}) })
  if (sc.none) add('一条都不提取', rows.length === 0, rows.map((r) => r.title))
  if (sc.noYes) add('没有「本人+直接添加」', !rows.some((r) => r.belongs === 'yes' && r.action === 'add'))
  for (const e of sc.expect ?? []) {
    const hit = rows.find((r) => e.title.test(r.title))
    const label = `「${e.title.source}」`
    if (!hit && e.optional) continue
    add(`${label} 被提取`, hit, rows.map((r) => r.title))
    if (!hit) continue
    if (e.belongs) add(`${label} 归属=${e.belongs}`, hit.belongs === e.belongs, hit.belongs)
    if (e.when) add(`${label} 时间=${e.when}`, hit.when === e.when, hit.when)
    if (e.whenDate) add(`${label} 日期=${e.whenDate}`, hit.when?.slice(0, 10) === e.whenDate, hit.when)
    if (e.field === 'due') add(`${label} 填在 due_time`, !!hit.due, { start: hit.start, due: hit.due })
    if (e.near) {
      const diff = hit.when ? Math.abs(new Date(hit.when).getTime() - e.near.getTime()) / 60_000 : Infinity
      add(`${label} 约 ${hm(e.near)}（±${e.toleranceMin}分）`, diff <= e.toleranceMin, hit.when)
    }
    if (e.notAdd && sc.channel !== 'quick-add') add(`${label} 不直接添加`, hit.action !== 'add', hit.action)
    if (e.location) add(`${label} 地点`, e.location.test(hit.location ?? ''), hit.location)
    if (e.notes) add(`${label} 注意事项`, hit.notes.some((n) => e.notes.test(n)), hit.notes)
    if (e.queued) add(`${label} 屏幕候选入队`, extra.queued?.some((q) => e.title.test(q.title)), extra.queued?.map((q) => q.title))
  }
  for (const re of sc.others ?? []) {
    const bad = rows.filter((r) => re.test(r.title) && r.belongs !== 'no')
    add(`他人的「${re.source}」不算到用户头上`, bad.length === 0, bad.map((r) => `${r.title}:${r.belongs}`))
  }
  for (const re of sc.forbidTitle ?? []) add(`不提取已被推翻的「${re.source}」`, !rows.some((r) => re.test(r.title)))
  for (const iso of sc.forbidWhen ?? []) add(`不用旧时间 ${iso}`, !rows.some((r) => r.when === iso))
  if (sc.noQueue) add('屏幕候选不入队', (extra.queued ?? []).length === 0, extra.queued?.map((q) => q.title))
  return { rows, checks }
}

// ---------- 跑 ----------
const report = { mode: live ? 'real-model' : 'offline-replay', now: now.toString(), cases: [], pipeline: [] }
const pipe = (name, pass, detail) => { report.pipeline.push({ name, pass: !!pass, ...(detail !== undefined ? { detail } : {}) }); if (!pass) process.exitCode = 1 }
let modelName = 'offline-fake'
try {
  if (live) {
    const path = option('--config')
    assert.ok(path, '--run 需要 --config')
    assert.equal(statSync(path).mode & 0o077, 0, 'config 必须 chmod 600')
    const cfg = JSON.parse(readFileSync(path, 'utf8'))
    const allowed = ['apiBase', 'apiKey', 'model', 'modelVision', 'modelChat', 'apiFormat']
    assert.ok(Object.keys(cfg).every((k) => allowed.includes(k)), `config 只能包含 ${allowed.join('/')}`)
    for (const k of ['apiBase', 'apiKey', 'model']) assert.ok(typeof cfg[k] === 'string' && cfg[k].trim(), `config 缺少 ${k}`)
    state.settings = { ...state.settings, apiFormat: 'auto', ...cfg, useCustomModel: true }
    modelName = cfg.model
    realFetch = originalFetch
  } else assert.ok(!option('--config'), '离线模式不读凭据')

  const Database = require('better-sqlite3')
  const db = (state.db = new Database(join(temp, 'daily.sqlite')))
  const schema = readFileSync(join(root, 'src/main/db/connection.ts'), 'utf8')
  for (const table of ['sources', 'tasks', 'detections', 'detection_notes']) {
    const m = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n {4}\\);`))
    assert.ok(m, `connection.ts 里找不到 ${table} 建表语句`)
    db.exec(m[0])
  }
  const migrations = await load('src/main/db-migrations.ts')
  migrations.migrateTaskReminders(db)
  migrations.migrateTaskExtras(db)
  migrations.migrateDetectionItems(db)

  const parsing = await load('src/shared/parsing.ts')
  const capture = await load('src/main/capture.ts')
  const { buildOcrText } = await load('src/main/screen-text.ts')
  const parser = await load('src/main/parser.ts')
  const { parsedToExtraction } = await load('src/main/detection-cards.ts')
  const { detectionQueueDecision } = await load('src/shared/detection-gate.ts')
  const { registerTaskIpc } = await load('src/main/ipc/task.ts')
  const lifecycle = await load('src/main/content-lifecycle.ts')
  const tasksDb = await load('src/main/db/tasks.ts')
  const { dueReminders, isDayDeadline } = await load('src/shared/task-reminder.ts')
  registerTaskIpc()
  const invoke = (channel, ...a) => {
    const h = state.handlers.get(channel)
    assert.ok(h, `通道未注册：${channel}`)
    return h({ sender: { id: 1, mainFrame: {} }, senderFrame: {} }, { contentEpoch: lifecycle.captureContentEpoch() }, ...a)
  }
  pipe('IPC：tasks:quick-add / assistant:chat 经 register 包装注册', state.handlers.has('tasks:quick-add') && state.handlers.has('assistant:chat'))

  // 懒加载：飞书 SDK、mammoth 在用到之前都不该被加载
  const feishu = await load('src/main/feishu.ts')
  pipe('飞书 SDK 在配置前未加载', state.lark.loaded === false)
  const mammothLoaded = () => Object.keys(require.cache).some((k) => k.includes('/node_modules/mammoth/'))
  pipe('mammoth 在拖入 Word 前未加载', !mammothLoaded())

  const selected = SCENARIOS.filter((sc) => !only || sc.id.includes(only) || sc.channel.includes(only))
  for (const sc of selected) {
    state.profile = sc.profile
    currentFake = (body) => idealOutput(sc, sc.channel === 'assistant-chat' ? 'assistant' : 'items')
    const before = new Set(tasksDb.listTasks().map((t) => t.id))
    const parsedFrom = state.parsed.length
    const started = performance.now()
    const entry = { id: sc.id, channel: sc.channel, title: sc.title, profile: sc.profile.name }
    try {
      let items = []
      const extra = {}
      if (sc.channel === 'clipboard' || sc.channel === 'voice') {
        entry.summary = await capture.parseAndStore({ type: sc.channel === 'voice' ? 'voice_note' : 'clipboard_text', text: sc.text })
        items = state.parsed.slice(parsedFrom).flatMap((p) => p.items)
      } else if (sc.channel === 'docx') {
        const txt = join(temp, `${sc.id}.txt`)
        const docx = join(temp, `${sc.id}.docx`)
        writeFileSync(txt, sc.lines.join('\n'))
        execFileSync('/usr/bin/textutil', ['-inputencoding', 'UTF-8', '-convert', 'docx', txt, '-output', docx])
        entry.summary = (await capture.submitFiles([docx]))[0]
        extra.mammothLoaded = mammothLoaded()
        items = state.parsed.slice(parsedFrom).flatMap((p) => p.items)
        entry.extractedText = state.parsed.at(-1)?.input.text
      } else if (sc.channel === 'quick-add') {
        entry.summary = await invoke('tasks:quick-add', sc.text)
        items = tasksDb.listTasks().filter((t) => !before.has(t.id))
      } else if (sc.channel === 'assistant-chat') {
        const res = await invoke('assistant:chat', { history: [{ role: 'user', content: sc.text }], candidates: null })
        entry.summary = { reply: res.reply, added: res.added?.map((a) => a.title), error: res.error ?? null }
        const addedRows = tasksDb.listTasks().filter((t) => !before.has(t.id))
        items = addedRows.length ? addedRows : (res.candidates ?? [])
        entry.addedDirectly = addedRows.length
      } else if (sc.channel === 'feishu') {
        if (!state.lark.handlers) {
          feishu.ensureFeishu()
          for (let i = 0; i < 50 && !state.lark.started; i++) await new Promise((r) => setTimeout(r, 10))
          pipe('飞书：配置后才懒加载 SDK 并建立长连接', state.lark.loaded && state.lark.started && feishu.feishuStatus().status === 'connected', feishu.feishuStatus())
        }
        const repliesBefore = state.lark.replies.length
        const { message_type, text, post, mentions } = sc.feishu
        const content = message_type === 'post' ? JSON.stringify(post) : JSON.stringify({ text })
        await state.lark.handlers['im.message.receive_v1']({ message: { message_id: `om_${sc.id}`, chat_id: 'oc_p2p', chat_type: 'p2p', message_type, content, mentions } })
        entry.reply = state.lark.replies.slice(repliesBefore).join(' / ')
        items = state.parsed.slice(parsedFrom).flatMap((p) => p.items)
        entry.modelSaw = state.parsed.at(-1)?.input.text?.split('=== 用户提交的内容 ===').at(-1)?.trim() ?? state.parsed.at(-1)?.input.text
      } else if (sc.channel === 'screen') {
        const boxes = sc.boxes.map(([text, x, y, w]) => ({ text, x, y, w, h: 0.03 }))
        const text = buildOcrText(boxes)
        entry.ocrText = text
        const { items: got } = await parser.parseToItemsRaw({ text, hint: capture.HINTS.screen_scan })
        items = got
        extra.queued = got.filter((i) => detectionQueueDecision(i, parsedToExtraction(i).strong) === 'queue')
      }
      const { rows, checks } = judge(sc, items, extra)
      if (sc.channel === 'docx') checks.unshift({ name: 'mammoth 拖入 Word 时才加载并抽出正文', pass: extra.mammothLoaded && /行动项/.test(entry.extractedText ?? '') })
      if (sc.channel === 'feishu' && !entry.reply) checks.unshift({ name: '飞书机器人回了结果', pass: false })
      if (sc.sawInput) checks.unshift({ name: `模型看到的正文还原了 @（${sc.sawInput.source}）`, pass: sc.sawInput.test(entry.modelSaw ?? ''), detail: entry.modelSaw })
      if (entry.summary?.error) checks.unshift({ name: '没有解析错误', pass: false, detail: entry.summary.error })
      const created = tasksDb.listTasks().filter((t) => !before.has(t.id))
      if (['clipboard', 'voice', 'docx', 'feishu'].includes(sc.channel)) {
        checks.push({ name: '入库：归属他人的条目不落库', pass: created.every((t) => t.belongsToUser !== 'no') })
        checks.push({ name: '入库：默认确认模式下进待确认', pass: created.every((t) => t.status === 'pending') })
      }
      if (sc.channel === 'quick-add') checks.push({ name: '快建：直接进日程且归属本人', pass: created.length > 0 && created.every((t) => t.belongsToUser === 'yes' && t.status !== 'pending') })
      Object.assign(entry, { items: rows, created: created.length, checks, pass: checks.every((c) => c.pass) })
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      if (state.settings.apiKey && live) message = message.replaceAll(state.settings.apiKey, '[REDACTED]')
      Object.assign(entry, { error: message.slice(0, 400), pass: false, checks: [] })
    }
    entry.ms = Math.round(performance.now() - started)
    report.cases.push(entry)
    const failed = entry.checks.filter((c) => !c.pass).map((c) => c.name)
    process.stderr.write(`${entry.pass ? '✓' : '✗'} ${sc.channel.padEnd(14)} ${sc.title}  (${entry.ms}ms)${entry.error ? `  ERROR ${entry.error}` : failed.length ? `  ✗ ${failed.join('；')}` : ''}\n`)
  }

  // 重复转发：同一条飞书消息 id 再投一次必须被去重，不能再解析、再回复
  if (state.lark.handlers) {
    const parsedBefore = state.parsed.length
    await state.lark.handlers['im.message.receive_v1']({ message: { message_id: 'om_feishu-text', chat_id: 'oc_p2p', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '重复投递' }) } })
    await state.lark.handlers['im.message.receive_v1']({ message: { message_id: 'om_group', chat_id: 'oc_group', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@林小谷 群里的消息' }) } })
    pipe('飞书：重复投递与群聊消息都不触发解析', state.parsed.length === parsedBefore)
  }

  // 用户在日程页把「确实是我的」待确认项点确认 → 进入提醒候选
  const pendingMine = tasksDb.listTasks().filter((t) => t.status === 'pending' && t.belongsToUser === 'yes')
  await invoke('tasks:confirm', pendingMine.map((t) => t.id))
  const candidates = tasksDb.listReminderCandidates()
  const timed = pendingMine.filter((t) => t.startTime || t.dueTime)
  pipe('确认后：本人且有时间的待确认项全部进入提醒候选（没时间的进「未开始」）',
    timed.every((t) => candidates.some((c) => c.id === t.id)) &&
      pendingMine.filter((t) => !timed.includes(t)).every((t) => tasksDb.getTask(t.id).status === 'not_started'),
    { confirmed: pendingMine.length, timed: timed.length, candidates: candidates.length })

  // 提醒时刻：用生产的 dueReminders 按分钟推演每条任务第一次响的时间（提前量 = 设置默认 5 分钟）。
  // 一般事件：事件前 5 分钟；只给了日期的截止（23:59）：截止当天 08:55，当天开机晚了就在截止前立刻补。
  const opts = { enabled: true, defaultOffsetMin: state.settings.taskReminderOffsetMin, catchupWindowMin: 120 }
  const MIN = 60_000
  report.reminderPlan = candidates.map((t) => {
    const ev = new Date(eventOf(t)).getTime()
    const day = isDayDeadline(t)
    const target = (day ? new Date(ev).setHours(9, 0, 0, 0) : ev) - 5 * MIN
    let fire = null
    for (let ms = Math.max(now.getTime(), target - 2 * MIN); ms <= ev + 3 * 3600_000; ms += MIN) {
      if (dueReminders([t], opts, new Date(ms)).length) { fire = new Date(ms); break }
    }
    return { title: t.title, event: eventOf(t), dayDeadline: day, firesAt: fire ? `${ymd(fire)}T${hm(fire)}` : null, target, ev }
  })
  const planOk = report.reminderPlan.every((p) => {
    const fireMs = p.firesAt ? new Date(p.firesAt).getTime() : null
    const lastChance = (p.dayDeadline ? p.ev : p.target) + 120 * MIN // 超过补提醒窗口的旧事不补
    if (now.getTime() > lastChance) return fireMs === null
    if (p.target <= now.getTime()) return fireMs !== null && fireMs - now.getTime() < MIN // 已到点：立刻补提醒
    return fireMs !== null && Math.abs(fireMs - p.target) < MIN // 未来：准点在目标时刻响
  })
  for (const p of report.reminderPlan) { delete p.target; delete p.ev }
  pipe('提醒推演：一般事件提前 5 分钟、整天截止当天 08:55 响（已过期太久的不补）', planOk, report.reminderPlan)

  // 真实提醒调度器：启动后 5 秒首轮 tick，「3 分钟后站会」应立刻弹提醒卡，且同一条不会重复弹
  if (selected.some((sc) => sc.id === 'quick-standup-soon')) {
    const reminder = await load('src/main/task-reminder.ts')
    reminder.startTaskReminder()
    await new Promise((r) => setTimeout(r, 5_600))
    const first = state.reminders.flatMap((p) => p.items.map((i) => i.title))
    reminder.startTaskReminder() // 重启调度 = 再跑一轮首轮 tick
    await new Promise((r) => setTimeout(r, 5_600))
    reminder.stopTaskReminder()
    const all = state.reminders.flatMap((p) => p.items.map((i) => i.title))
    pipe('调度器：临近的站会弹出提醒卡并播报到桌宠', first.some((t) => /站会/.test(t)) && state.petSays.some((s) => /站会/.test(s)), first)
    pipe('调度器：同一提醒不重复弹', all.length === first.length, all)
  }
} catch (error) {
  report.fatal = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  try { state.db?.close() } catch {}
  rmSync(temp, { recursive: true, force: true })
  const total = report.cases.flatMap((c) => c.checks)
  report.summary = {
    model: modelName,
    cases: report.cases.length,
    casesPassed: report.cases.filter((c) => c.pass).length,
    checks: total.length,
    checksPassed: total.filter((c) => c.pass).length,
    pipelinePassed: report.pipeline.filter((p) => p.pass).length,
    pipeline: report.pipeline.length
  }
  let text = JSON.stringify(report, null, 2)
  if (live && state.settings.apiKey) text = text.replaceAll(state.settings.apiKey, '[REDACTED]')
  if (option('--out')) writeFileSync(option('--out'), `${text}\n`, { mode: 0o600 })
  for (const p of report.pipeline) process.stderr.write(`${p.pass ? '✓' : '✗'} [链路] ${p.name}\n`)
  if (report.fatal) process.stderr.write(`FATAL ${report.fatal}\n`)
  process.stderr.write(`\n场景 ${report.summary.casesPassed}/${report.summary.cases} 全对，检查点 ${report.summary.checksPassed}/${report.summary.checks}，链路 ${report.summary.pipelinePassed}/${report.summary.pipeline}（${report.mode}，模型 ${modelName}）\n`)
  if (!live && report.summary.casesPassed !== report.summary.cases) process.exitCode = 1
  delete globalThis[KEY]
}
