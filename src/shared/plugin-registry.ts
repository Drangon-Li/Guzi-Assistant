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
      achievementCounters: true,
      // 装了「专注」就能收到回写；没装就什么都不会发生，作息本身不受影响
      listens: ['pomodoro:round-completed'],
      assistantActions: [
        {
          name: 'add-block',
          summary: '在作息表上排一段时间',
          args: '{"title":要做什么,"start":"HH:MM","end":"HH:MM","date":可选 "YYYY-MM-DD"，默认今天}',
          when: '用户说「下午两点到四点看论文」「帮我把明早九点排成写代码」这类带起止时间的安排时用。'
        }
      ]
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
      homeCards: ['pomodoro-today'],
      achievementCounters: true,
      emits: [
        { name: 'round-completed', summary: '一轮专注完成（含关联的时间块与任务）' },
        { name: 'break-completed', summary: '一轮休息结束' }
      ],
      assistantActions: [
        {
          name: 'start-focus',
          summary: '立刻开始一轮专注计时',
          args: '{"minutes":可选，1-180，不填用用户设置的默认时长,"task":可选，这一轮要做的事}',
          when: '用户说「定个 25 分钟番茄钟」「开始专注」「帮我计时半小时写代码」时用。'
        },
        {
          name: 'pause-focus',
          summary: '暂停正在跑的这一轮',
          args: '{}',
          when: '用户说「暂停一下」「先停一停」时用。'
        },
        {
          name: 'resume-focus',
          summary: '继续被暂停的这一轮',
          args: '{}',
          when: '用户说「继续」「接着计时」时用。'
        },
        {
          name: 'stop-focus',
          summary: '结束当前这一轮（记为中途放弃）',
          args: '{}',
          when: '用户说「不专注了」「停掉番茄钟」时用。'
        }
      ]
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
      achievementCounters: true,
      assistantActions: [
        {
          name: 'check',
          summary: '给某个习惯打今天的卡',
          args: '{"name":习惯名，模糊匹配已有习惯}',
          when: '用户说「今天的步数打卡」「我读完了，打个卡」时用。找不到同名习惯就不要调用，在 reply 里问清楚。'
        },
        {
          name: 'skip',
          summary: '把某个习惯今天记为跳过（连续不断）',
          args: '{"name":习惯名}',
          when: '用户说「今天出差跑不了步，跳过」时用。'
        }
      ]
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
  },
  {
    id: 'notebook',
    name: '记事本',
    version: '1.0.0',
    minAppVersion: '0.7.0',
    summary: '随手写点什么，Markdown 记，按分类和标签收',
    description:
      '不进日程也不进打卡的那些内容——想法、会议纪要、读到的东西，都往这儿放。' +
      '正文是 Markdown，选中文字会浮出工具栏，加粗、标题、高亮点一下就行。' +
      '笔记可以放进分类（分类能套分类），也可以打标签，两种归拢方式互不影响。' +
      '生成日报后可以直接存成一篇笔记，接着在上面补自己的话。',
    category: 'note',
    contributes: {
      nav: { label: '记事本', order: 140 },
      contentSinks: [{ action: 'save-content', label: '保存到记事本' }]
    },
    storage: { tables: ['p_notebook_folder', 'p_notebook_note'] }
  }
] as const satisfies PluginRegistry

export type PluginId = (typeof PLUGINS)[number]['id']

export function findPlugin(id: string): PluginManifest | undefined {
  return PLUGINS.find((p) => p.id === id)
}
