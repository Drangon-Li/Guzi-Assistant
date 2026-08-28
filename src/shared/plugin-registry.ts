// 内置插件注册表：单一事实源。
// 主进程按它建表和注册 IPC，渲染层按它渲染导航和 Market，测试按它校验前缀约束。
// 新增插件先加这里，再去 main/plugins/ 和 renderer/src/plugins/ 补实现——
// test/plugin-smoke.mjs 会卡住「声明了却没实现」和「实现了却没声明」两个方向。
//
// minAppVersion 对内置插件恒成立（插件代码和框架是同一个包，装得上就一定配套），
// 填当前版本即可，不要填「将要发布的下一个版本」——那会让 Market 里所有插件在发版前
// 都显示成「需要更高版本」而无法启用。这个字段真正的用武之地是将来的外部插件。
import type { PluginManifest, PluginRegistry } from './plugin-manifest'

export const PLUGINS = [
  {
    id: 'timeblock',
    name: '作息',
    version: '1.0.0',
    minAppVersion: '0.6.0',
    summary: '按时间块规划一天，存成模板每天套用',
    description:
      '「日程」管有截止时间的任务，「作息」管有起止时间的安排——上午十一点看论文、十二点吃饭。' +
      '把常用的一天存成模板，之后一键套用或按星期自动套用。开了活动历史的话，' +
      '计划的块和实际的工作记录会叠在同一条时间轴上，一眼看出计划和实际差在哪。',
    category: 'planning',
    contributes: {
      nav: { label: '作息', order: 100 },
      homeCards: ['timeblock-today'],
      achievementCounters: true
    },
    storage: { tables: ['p_timeblock_block', 'p_timeblock_template', 'p_timeblock_template_block'] }
  },
  {
    id: 'pomodoro',
    name: '专注',
    version: '1.0.0',
    minAppVersion: '0.6.0',
    summary: '番茄钟：计时、休息提醒与专注时长统计',
    description:
      '一轮专注加一轮休息，结束由桌宠气泡播报。统计页看每天累计专注时长和完成轮数。' +
      '装了「作息」之后，时间块上会多一个「开始专注」，专注结束把实际用时回写到那个块。',
    category: 'focus',
    enhances: ['timeblock'],
    contributes: {
      nav: { label: '专注', order: 110 },
      settings: { label: '专注' },
      homeCards: ['pomodoro-today'],
      achievementCounters: true
    },
    storage: { tables: ['p_pomodoro_session'] }
  },
  {
    id: 'habit',
    name: '打卡',
    version: '1.0.0',
    minAppVersion: '0.6.0',
    summary: '每日小目标，一键打卡，连续天数不清零',
    description:
      '给自己立小到不会失败的每日目标——走 20 分钟、读 10 页。每个习惯显示当前连续、' +
      '累计次数和最近 28 天的小日历。今天还没打不算断，断了也不清零，接着打就是。' +
      '不再想做的习惯归档即可，历史打卡记录保留。',
    category: 'habit',
    contributes: {
      nav: { label: '打卡', order: 120 },
      homeCards: ['habit-today'],
      achievementCounters: true
    },
    storage: { tables: ['p_habit_habit', 'p_habit_check'] }
  },
  {
    id: 'achievement',
    name: '成就',
    version: '1.0.0',
    minAppVersion: '0.6.0',
    summary: '把长期的坚持变成看得见的收藏',
    description:
      '成就墙。只装核心也有成就——首次捕获、累计确认任务、连续使用天数、日报篇数；' +
      '每多启用一个插件，就多一批对应的成就。点开每条成就能看到具体的获得路径。' +
      '只奖励记录与坚持本身，没有断签清零。',
    category: 'reward',
    enhances: ['timeblock', 'pomodoro', 'habit'],
    contributes: {
      nav: { label: '成就', order: 130 }
    },
    storage: { tables: ['p_achievement_unlock'] }
  }
] as const satisfies PluginRegistry

export type PluginId = (typeof PLUGINS)[number]['id']

export function findPlugin(id: string): PluginManifest | undefined {
  return PLUGINS.find((p) => p.id === id)
}
