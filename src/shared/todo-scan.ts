// 待办识别专用扫描的判定：哪些 App 值得为了「抓待办」看一眼屏幕文字，以及多久看一次。
//
// 存在的理由：hybrid v2 在语义完整（有 App + 窗口标题）时会跳过 OCR，而待办抽取
// 必须读正文——「周五下午三点交」只写在聊天气泡里，App 名和窗口标题里没有。
// 所以给待办识别一条独立的触发通道，只在内容型 App 前台时按较长间隔放行一次。
//
// 与 app-categories 那套 productive/neutral/distracting 口径不同（那是算专注时长用的），故不复用。

export type TodoScanAppKind = 'im' | 'mail' | 'browser' | 'docs' | 'calendar' | null

const BUNDLE_KINDS: Record<string, Exclude<TodoScanAppKind, null>> = {
  'com.tencent.xinwechat': 'im',
  'com.tencent.wework': 'im',
  'com.tencent.qq': 'im',
  'com.electron.lark': 'im',
  'com.bytedance.lark': 'im',
  'com.alibaba.dingtalk': 'im',
  'com.tinyspeck.slackmacgap': 'im',
  'com.hnc.discord': 'im',
  'ru.keepcoder.telegram': 'im',
  'com.apple.mail': 'mail',
  'com.microsoft.outlook': 'mail',
  'com.readdle.smartemail-mac': 'mail',
  'com.apple.safari': 'browser',
  'com.google.chrome': 'browser',
  'com.microsoft.edgemac': 'browser',
  'company.thebrowser.browser': 'browser',
  'notion.id': 'docs',
  'com.yuque.app': 'docs',
  'md.obsidian': 'docs',
  'com.apple.notes': 'docs',
  'com.apple.ical': 'calendar',
  'com.flexibits.fantastical2.mac': 'calendar'
}

// 名字兜底：bundleId 缺失（无 Accessibility）或未收录（第三方分支版本）时用。
// 顺序有意义：先匹配到的先返回，所以把更具体的写在前面。
const NAME_KINDS: [readonly string[], Exclude<TodoScanAppKind, null>][] = [
  [['微信', 'wechat', '企业微信', 'qq', '飞书', 'lark', '钉钉', 'dingtalk', 'slack', 'discord', 'telegram'], 'im'],
  [['邮件', 'mail', 'outlook', 'spark', 'foxmail'], 'mail'],
  [['safari', 'chrome', 'edge', 'arc', 'firefox'], 'browser'],
  [['notion', '语雀', 'yuque', 'obsidian', '备忘录', 'notes', 'bear', 'craft'], 'docs'],
  [['日历', 'calendar', 'fantastical'], 'calendar']
]

/** 英文词按词边界匹配——纯 includes 会让 'arc' 命中 Search、'edge' 命中 EdgeDB，白扫一次要扣积分。
 *  中文没有词边界，只能包含匹配。 */
function nameHasTerm(name: string, term: string): boolean {
  if (name === term) return true
  if (/^[a-z0-9]+$/.test(term)) return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(name)
  return name.includes(term)
}

export function todoScanAppKind(appName: string | null, bundleId: string | null): TodoScanAppKind {
  const bundle = (bundleId ?? '').trim().toLowerCase()
  if (bundle && BUNDLE_KINDS[bundle]) return BUNDLE_KINDS[bundle]
  const name = (appName ?? '').trim().toLowerCase()
  if (!name) return null
  for (const [terms, kind] of NAME_KINDS) if (terms.some((term) => nameHasTerm(name, term))) return kind
  return null
}

export interface TodoScanInput {
  enabled: boolean
  appKind: TodoScanAppKind
  nowMs: number
  lastTodoScanAtMs: number | null
  intervalSec: number
}

export function shouldTodoScan(input: TodoScanInput): boolean {
  if (!input.enabled || input.appKind === null) return false
  if (input.lastTodoScanAtMs === null) return true
  return input.nowMs - input.lastTodoScanAtMs >= input.intervalSec * 1000
}
