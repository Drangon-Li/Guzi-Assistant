/**
 * 进程级监控的默认允许名单：只在这些 App 前台时才扫描（聊天/通知类）。
 * 中英文名都列（getFrontmostApp 返回本地化名）；用户可在设置增删，留空=监控全部。
 */
export const DEFAULT_MONITORED_APPS = [
  '微信',
  'WeChat',
  '企业微信',
  'WeCom',
  '钉钉',
  'DingTalk',
  'QQ',
  'TIM',
  '飞书',
  'Lark',
  'Telegram',
  'Slack'
]
