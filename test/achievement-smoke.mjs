// 纯函数单测：成就的解锁判定与插件联动。运行：npm run test achievement
//
// 关键行为：计数器来源插件没启用时，成就要标 locked 且进度归零——
// 否则停用再启用会看到进度诡异地跳，用户会以为数据丢了。
import {
  ACHIEVEMENTS,
  closestToUnlock,
  computeAchievements,
  groupAchievements,
  lockedCountByPlugin,
  newlyUnlocked,
  recentlyUnlocked,
  summarize
} from '../src/shared/achievement.ts'
import { PLUGINS } from '../src/shared/plugin-registry.ts'

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const DEFS = [
  { key: 'core_a', name: '核心一', desc: '', howTo: '', icon: 'seed', counter: 'c', target: 10 },
  { key: 'core_b', name: '核心二', desc: '', howTo: '', icon: 'ear', counter: 'c', target: 100 },
  { key: 'hab_a', name: '打卡一', desc: '', howTo: '', icon: 'sprout', counter: 'h', target: 5, plugin: 'habit' }
]

// ---------- 基本判定 ----------
let views = computeAchievements({ c: 10, h: 9 }, {}, [], DEFS)
check('达标的核心成就 current 到顶', views[0].current === 10)
check('进度 1', views[0].progress === 1)
check('未达标进度按比例', views[1].progress === 0.1)
check('未解锁时 unlocked=false', views[0].unlocked === false)

check('插件没启用 → locked', views[2].locked === true)
check('locked 的进度归零（不展示未启用插件的历史数据）', views[2].current === 0 && views[2].progress === 0)

views = computeAchievements({ c: 10, h: 9 }, {}, ['habit'], DEFS)
check('插件启用后不再 locked', views[2].locked === false)
check('启用后进度恢复', views[2].current === 5)

// ---------- 新解锁 ----------
check('达标且未记录 → 新解锁', eq(newlyUnlocked(views), ['core_a', 'hab_a']))
check(
  '已记录过就不再算新解锁（不重放庆祝动画）',
  eq(newlyUnlocked(computeAchievements({ c: 10, h: 9 }, { core_a: '2026-08-01T00:00:00' }, ['habit'], DEFS)), [
    'hab_a'
  ])
)
check(
  'locked 的成就即便计数够也不解锁',
  !newlyUnlocked(computeAchievements({ c: 0, h: 999 }, {}, [], DEFS)).includes('hab_a')
)
check('计数缺失当 0', computeAchievements({}, {}, [], DEFS)[0].current === 0)
check('负数计数当 0', computeAchievements({ c: -5 }, {}, [], DEFS)[0].current === 0)

const unlocked = computeAchievements({ c: 10 }, { core_a: '2026-08-01T00:00:00' }, [], DEFS)
check('解锁时刻带出来', unlocked[0].unlockedAt === '2026-08-01T00:00:00')
check('unlocked=true', unlocked[0].unlocked === true)

// ---------- 汇总 ----------
check('只装核心时 available 不含插件成就', eq(summarize(computeAchievements({}, {}, [], DEFS)), {
  unlocked: 0,
  available: 2,
  total: 3
}))
check(
  '启用插件后 available 变大',
  summarize(computeAchievements({}, {}, ['habit'], DEFS)).available === 3
)

// ---------- 真实成就表 ----------
check('成就 key 不重复', new Set(ACHIEVEMENTS.map((a) => a.key)).size === ACHIEVEMENTS.length)
check('每条都有获得路径（不是同义反复的描述）', ACHIEVEMENTS.every((a) => a.howTo.length > 8))
check('target 都是正数', ACHIEVEMENTS.every((a) => a.target > 0))
const pluginIds = new Set(PLUGINS.map((p) => p.id))
check(
  '引用的 plugin 都在注册表里',
  ACHIEVEMENTS.every((a) => !a.plugin || pluginIds.has(a.plugin)),
  JSON.stringify(ACHIEVEMENTS.filter((a) => a.plugin && !pluginIds.has(a.plugin)).map((a) => a.key))
)
check('有核心成就（一个插件都不装也有得拿）', ACHIEVEMENTS.some((a) => !a.plugin))
check('打卡插件带来的成就条数', lockedCountByPlugin('habit') === 4)
check('不存在的插件返回 0', lockedCountByPlugin('ghost') === 0)

// 每个声明了 achievementCounters 的插件都该真的有成就，否则 Market 上的
// 「启用后成就墙会多 N 条」会显示成 0 条
for (const p of PLUGINS) {
  if (!('achievementCounters' in p.contributes && p.contributes.achievementCounters)) continue
  check(`${p.id} 声明供给计数器，就该有对应成就`, lockedCountByPlugin(p.id) > 0)
}

// ---------- 分级 ----------
// 档位由同一计数器下的阈值排名推导，不手工标注——加一条更高阈值的不用回头改别人
const TIERED = [
  { key: 'a1', name: '一', desc: '', howTo: '', icon: 'seed', counter: 'c', target: 1 },
  { key: 'a3', name: '三', desc: '', howTo: '', icon: 'ear', counter: 'c', target: 200 },
  { key: 'a2', name: '二', desc: '', howTo: '', icon: 'sprout', counter: 'c', target: 30 },
  { key: 'b1', name: '别的', desc: '', howTo: '', icon: 'moon', counter: 'd', target: 5 }
]
const tv = computeAchievements({ c: 0, d: 0 }, {}, [], TIERED)
const tierOf = (k) => tv.find((v) => v.key === k).tier
check('最低阈值是铜', tierOf('a1') === 'bronze')
check('次低是银（与声明顺序无关）', tierOf('a2') === 'silver')
check('最高是金', tierOf('a3') === 'gold')
check('另一条计数器线独立分级', tierOf('b1') === 'bronze')

// ---------- 前置提示 ----------
check('未解锁的低档条目会被列为前置', tv.find((v) => v.key === 'a2').prerequisite === '一')
check('最低档没有前置', tv.find((v) => v.key === 'a1').prerequisite === null)
const tv2 = computeAchievements({ c: 0 }, { a1: '2026-08-01T00:00:00' }, [], TIERED)
check('低档已解锁则不再提示前置', tv2.find((v) => v.key === 'a2').prerequisite === null)

// ---------- 分组 ----------
const realViews = computeAchievements({}, {}, ['timeblock', 'pomodoro', 'habit'])
const groups = groupAchievements(realViews)
check('分组非空', groups.length > 0)
check('组内条目数加起来等于总数', groups.reduce((n, g) => n + g.items.length, 0) === realViews.length)
check('组名有序且不重复', new Set(groups.map((g) => g.group)).size === groups.length)
check('每条成就都归到了某个组', realViews.every((v) => !!v.group))
check('空组不返回', groupAchievements([]).length === 0)

// ---------- 最近解锁 / 快达成 ----------
const unlockedViews = computeAchievements(
  { c: 250, d: 0 },
  { a1: '2026-08-01T00:00:00', a2: '2026-08-20T00:00:00' },
  [],
  TIERED
)
check('最近解锁按时间倒序', eq(recentlyUnlocked(unlockedViews).map((v) => v.key), ['a2', 'a1']))
check('最近解锁可限制条数', recentlyUnlocked(unlockedViews, 1).length === 1)
check('没解锁过就返回空', recentlyUnlocked(tv).length === 0)

// a1 已记过解锁——实际调用里 list 会先持久化再返回，所以满进度的条目不会滞留在这
const near = computeAchievements({ c: 25 }, { a1: '2026-08-01T00:00:00' }, [], TIERED)
check('快达成按进度降序', eq(closestToUnlock(near).map((v) => v.key), ['a2', 'a3']))
check('没开始的不进「快达成」', closestToUnlock(computeAchievements({ c: 0 }, {}, [], TIERED)).length === 0)
check('已解锁的不进「快达成」', !closestToUnlock(unlockedViews).some((v) => v.unlocked))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
