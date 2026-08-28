// 成就插件的纯逻辑：声明式成就表 + 由计数器算出解锁状态。
//
// 结构移植自 health-tracker 的 lib/achievements.ts（一张 DEFS 表 + 一个计算函数，
// 新增成就只加一行），但两处改动：
//  1. 图标是自绘的谷穗系列（icon 是语义名，渲染层映射到 SVG）。原版用星露谷 wiki 的
//     物品图，那是自用工具；谷子助手是公开发行的安装包，不能带第三方素材。
//  2. 计数器不再直接查库，而是由各插件供给——没装「打卡」就没有打卡计数器，
//     对应成就在墙上灰显并提示去 Market 装。这是插件扩展插件的落点。
//
// 导向也沿用原版：只奖励记录与坚持本身，没有断签清零，没有「忍住了多少」。

/** 自绘谷穗系列的图标语义名；渲染层 GrainIcons.tsx 负责映射到 SVG。 */
export type AchievementIcon =
  | 'seed'
  | 'sprout'
  | 'stalk'
  | 'ear'
  | 'bundle'
  | 'field'
  | 'granary'
  | 'sun'
  | 'moon'
  | 'rain'
  | 'scythe'
  | 'crown'

export interface AchievementDef {
  key: string
  name: string
  desc: string
  /** 获得路径：具体该怎么做，不是同义反复的描述 */
  howTo: string
  icon: AchievementIcon
  /** 读哪个计数器 */
  counter: string
  target: number
  /** 依赖哪个插件供给计数器；不填表示核心成就，装不装插件都算 */
  plugin?: string
}

export interface AchievementView extends AchievementDef {
  current: number
  progress: number
  unlocked: boolean
  unlockedAt: string | null
  /** 计数器来源插件没启用——墙上灰显，点开提示去 Market */
  locked: boolean
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // ---------- 核心：只装谷子助手就能拿 ----------
  {
    key: 'first_capture',
    name: '第一粒',
    desc: '确认了第一条事项',
    howTo: '复制一句带时间的话，按快捷键提交，在弹出的卡片上点确认。',
    icon: 'seed',
    counter: 'core_tasks_confirmed',
    target: 1
  },
  {
    key: 'tasks_30',
    name: '积粒成穗',
    desc: '累计确认 30 条事项',
    howTo: '正常用下去就行。剪贴板、截图、快捷提问、飞书，走哪条路都算。',
    icon: 'sprout',
    counter: 'core_tasks_confirmed',
    target: 30
  },
  {
    key: 'tasks_200',
    name: '满仓',
    desc: '累计确认 200 条事项',
    howTo: '两百条。到这一步，谷子助手已经接住了你相当一部分的记性。',
    icon: 'granary',
    counter: 'core_tasks_confirmed',
    target: 200
  },
  {
    key: 'streak_7',
    name: '七日不辍',
    desc: '连续 7 天都记下了东西',
    howTo: '连着七天，每天至少捕获一条事项。中断了不清零别的进度，从当下接着来。',
    icon: 'stalk',
    counter: 'core_active_streak',
    target: 7
  },
  {
    key: 'streak_30',
    name: '一轮满月',
    desc: '连续 30 天都记下了东西',
    howTo: '和「七日不辍」一样，坚持到三十天。',
    icon: 'moon',
    counter: 'core_active_streak',
    target: 30
  },
  {
    key: 'days_100',
    name: '百日存档',
    desc: '累计 100 天记下过事情',
    howTo: '不要求连续，累计有一百天捕获过内容即可，断了也一直在涨。',
    icon: 'field',
    counter: 'core_active_days',
    target: 100
  },
  {
    key: 'reports_10',
    name: '有据可查',
    desc: '生成 10 篇日报',
    howTo: '在「日报」页点生成，或者在设置里开定时生成，攒够十篇。',
    icon: 'rain',
    counter: 'core_reports',
    target: 10
  },
  {
    key: 'reports_50',
    name: '一季记录',
    desc: '生成 50 篇日报',
    howTo: '五十篇日报，差不多是一个季度的完整留痕。',
    icon: 'scythe',
    counter: 'core_reports',
    target: 50
  },

  // ---------- 作息 ----------
  {
    key: 'block_first',
    name: '排下第一块',
    desc: '创建了第一个时间块',
    howTo: '在「作息」页点空白时段，写上要做的事和起止时间。',
    icon: 'seed',
    counter: 'timeblock_blocks',
    target: 1,
    plugin: 'timeblock'
  },
  {
    key: 'block_100',
    name: '把日子排成行',
    desc: '累计创建 100 个时间块',
    howTo: '累计排一百块。用模板套用出来的也算。',
    icon: 'stalk',
    counter: 'timeblock_blocks',
    target: 100,
    plugin: 'timeblock'
  },
  {
    key: 'template_first',
    name: '有了章法',
    desc: '存下第一个作息模板',
    howTo: '把满意的一天存成模板，之后一键套用，或者设成每周几自动提示。',
    icon: 'ear',
    counter: 'timeblock_templates',
    target: 1,
    plugin: 'timeblock'
  },
  {
    key: 'planned_days_30',
    name: '三十天有谱',
    desc: '有 30 天排过作息',
    howTo: '累计三十天排过至少一个时间块，不要求连续。',
    icon: 'field',
    counter: 'timeblock_planned_days',
    target: 30,
    plugin: 'timeblock'
  },

  // ---------- 专注 ----------
  {
    key: 'focus_first',
    name: '第一轮',
    desc: '完成了第一轮专注',
    howTo: '在「专注」页点开始，把一轮完整走完。中途放弃不算，但也不扣什么。',
    icon: 'sun',
    counter: 'pomodoro_rounds',
    target: 1,
    plugin: 'pomodoro'
  },
  {
    key: 'focus_100',
    name: '百轮',
    desc: '累计完成 100 轮专注',
    howTo: '一天两三轮，一个多月就到了。',
    icon: 'bundle',
    counter: 'pomodoro_rounds',
    target: 100,
    plugin: 'pomodoro'
  },
  {
    key: 'focus_hours_50',
    name: '五十小时',
    desc: '累计专注 50 小时',
    howTo: '按完成的专注轮次累计时长，达到三千分钟。',
    icon: 'granary',
    counter: 'pomodoro_focus_minutes',
    target: 3000,
    plugin: 'pomodoro'
  },
  {
    key: 'focus_day_6',
    name: '沉得下去的一天',
    desc: '单日完成 6 轮专注',
    howTo: '某一天完整走完六轮。这样的日子不用多，有过就知道自己能做到。',
    icon: 'crown',
    counter: 'pomodoro_best_day',
    target: 6,
    plugin: 'pomodoro'
  },

  // ---------- 打卡 ----------
  {
    key: 'habit_first',
    name: '小目标，启动',
    desc: '完成了第一次打卡',
    howTo: '在「打卡」页立一个小到不会失败的每日目标，完成后点一下。',
    icon: 'seed',
    counter: 'habit_checks',
    target: 1,
    plugin: 'habit'
  },
  {
    key: 'habit_50',
    name: '习惯的形状',
    desc: '累计打卡 50 次',
    howTo: '所有习惯加起来打满五十次。断了也不清零，接着打就是。',
    icon: 'sprout',
    counter: 'habit_checks',
    target: 50,
    plugin: 'habit'
  },
  {
    key: 'habit_200',
    name: '积少成多',
    desc: '累计打卡 200 次',
    howTo: '两百次打卡。小目标的复利，比大目标的誓言可靠。',
    icon: 'bundle',
    counter: 'habit_checks',
    target: 200,
    plugin: 'habit'
  },
  {
    key: 'habit_streak_14',
    name: '两周如一',
    desc: '一个习惯连续打卡 14 天',
    howTo: '任意一个习惯连着打十四天。今天还没打不算断，明天补上接着数。',
    icon: 'crown',
    counter: 'habit_best_streak',
    target: 14,
    plugin: 'habit'
  }
]

export type CounterMap = Readonly<Record<string, number>>
/** key → 解锁时刻 ISO */
export type UnlockMap = Readonly<Record<string, string>>

/**
 * 算出每条成就的当前状态。计数器来源插件没启用的条目标 locked，
 * 进度按 0 算——不然停用插件再启用会看到进度诡异地跳。
 */
export function computeAchievements(
  counters: CounterMap,
  unlocks: UnlockMap,
  enabledPlugins: readonly string[],
  defs: readonly AchievementDef[] = ACHIEVEMENTS
): AchievementView[] {
  const enabled = new Set(enabledPlugins)
  return defs.map((def) => {
    const locked = !!def.plugin && !enabled.has(def.plugin)
    const current = locked ? 0 : Math.max(0, counters[def.counter] ?? 0)
    const unlockedAt = unlocks[def.key] ?? null
    return {
      ...def,
      current: Math.min(current, def.target),
      progress: def.target > 0 ? Math.min(1, current / def.target) : 0,
      unlocked: !!unlockedAt,
      unlockedAt,
      locked
    }
  })
}

/** 这一轮新达成、还没记过解锁时间的成就 key——调用方据此写库并放庆祝动画。 */
export function newlyUnlocked(views: readonly AchievementView[]): string[] {
  return views.filter((v) => !v.locked && !v.unlocked && v.current >= v.target).map((v) => v.key)
}

export interface AchievementSummary {
  unlocked: number
  /** 当前插件组合下可解锁的总数 */
  available: number
  /** 含被插件锁住的全部成就 */
  total: number
}

export function summarize(views: readonly AchievementView[]): AchievementSummary {
  return {
    unlocked: views.filter((v) => v.unlocked).length,
    available: views.filter((v) => !v.locked).length,
    total: views.length
  }
}

/** 被某个未启用插件锁住的成就条数——Market 卡片用它说「装了会多几条」。 */
export function lockedCountByPlugin(
  pluginId: string,
  defs: readonly AchievementDef[] = ACHIEVEMENTS
): number {
  return defs.filter((d) => d.plugin === pluginId).length
}
