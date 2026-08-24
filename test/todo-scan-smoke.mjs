// 纯函数单测：待办识别扫描的 App 词典与间隔门。运行：npm run test:todoscan
import { todoScanAppKind, shouldTodoScan } from '../src/shared/todo-scan.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- bundleId 精确匹配 ----
check('微信 → im', todoScanAppKind('WeChat', 'com.tencent.xinWeChat') === 'im')
check('飞书 → im', todoScanAppKind('Lark', 'com.electron.lark') === 'im')
check('钉钉 → im', todoScanAppKind('DingTalk', 'com.alibaba.DingTalk') === 'im')
check('Slack → im', todoScanAppKind('Slack', 'com.tinyspeck.slackmacgap') === 'im')
check('Mail → mail', todoScanAppKind('Mail', 'com.apple.mail') === 'mail')
check('Outlook → mail', todoScanAppKind('Outlook', 'com.microsoft.Outlook') === 'mail')
check('Safari → browser', todoScanAppKind('Safari', 'com.apple.Safari') === 'browser')
check('Chrome → browser', todoScanAppKind('Google Chrome', 'com.google.Chrome') === 'browser')
check('Arc → browser', todoScanAppKind('Arc', 'company.thebrowser.Browser') === 'browser')
check('Notion → docs', todoScanAppKind('Notion', 'notion.id') === 'docs')
check('Obsidian → docs', todoScanAppKind('Obsidian', 'md.obsidian') === 'docs')
check('日历 → calendar', todoScanAppKind('Calendar', 'com.apple.iCal') === 'calendar')

// ---- bundleId 大小写不敏感 ----
check('bundleId 大小写不敏感', todoScanAppKind(null, 'COM.APPLE.SAFARI') === 'browser')

// ---- App 名兜底（bundleId 缺失/未收录）----
check('无 bundleId 用名字兜底：微信', todoScanAppKind('微信', null) === 'im')
check('无 bundleId 用名字兜底：企业微信', todoScanAppKind('企业微信', null) === 'im')
check('无 bundleId 用名字兜底：邮件', todoScanAppKind('邮件', null) === 'mail')
check('无 bundleId 用名字兜底：语雀', todoScanAppKind('语雀', null) === 'docs')
check('未收录 bundleId 也走名字兜底', todoScanAppKind('Telegram', 'org.unknown.telegram.fork') === 'im')

// ---- 非内容型 App ----
for (const [name, bundle] of [
  ['Terminal', 'com.apple.Terminal'],
  ['Visual Studio Code', 'com.microsoft.VSCode'],
  ['Figma', 'com.figma.Desktop'],
  ['Xcode', 'com.apple.dt.Xcode'],
  ['Finder', 'com.apple.finder']
])
  check(`${name} → null`, todoScanAppKind(name, bundle) === null)
check('全空 → null', todoScanAppKind(null, null) === null)

// ---- 英文词边界：不能被子串误命中（误命中 = 白扫一次扣积分）----
check("'Search' 不被 arc 命中", todoScanAppKind('Search', null) === null)
check("'EdgeDB' 不被 edge 命中", todoScanAppKind('EdgeDB', null) === null)
check("'Gmail' 不被 mail 命中", todoScanAppKind('Gmail', null) === null)
check("'Monarch' 不被 arc 命中", todoScanAppKind('Monarch', null) === null)
check("'Microsoft Edge' 正常命中", todoScanAppKind('Microsoft Edge', null) === 'browser')
check("'Google Chrome' 正常命中", todoScanAppKind('Google Chrome', null) === 'browser')
check("'Spark Mail' 正常命中", todoScanAppKind('Spark Mail', null) === 'mail')
check('空串 → null', todoScanAppKind('', '') === null)

// ---- 间隔门 ----
const base = { enabled: true, appKind: 'im', nowMs: 1_000_000, intervalSec: 180 }
check('从未扫过 → 放行', shouldTodoScan({ ...base, lastTodoScanAtMs: null }) === true)
check('间隔未到 → 拦住', shouldTodoScan({ ...base, lastTodoScanAtMs: 1_000_000 - 179_000 }) === false)
check('间隔正好到 → 放行', shouldTodoScan({ ...base, lastTodoScanAtMs: 1_000_000 - 180_000 }) === true)
check('间隔已过 → 放行', shouldTodoScan({ ...base, lastTodoScanAtMs: 1_000_000 - 400_000 }) === true)
check('开关关 → 拦住', shouldTodoScan({ ...base, enabled: false, lastTodoScanAtMs: null }) === false)
check('非内容型 App → 拦住', shouldTodoScan({ ...base, appKind: null, lastTodoScanAtMs: null }) === false)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
