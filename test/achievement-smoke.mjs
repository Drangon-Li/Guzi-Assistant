// 纯函数单测：成就的解锁判定与插件联动。运行：npm run test achievement
//
// 关键行为：计数器来源插件没启用时，成就要标 locked 且进度归零——
// 否则停用再启用会看到进度诡异地跳，用户会以为数据丢了。
import {
  ACHIEVEMENTS,
  computeAchievements,
  lockedCountByPlugin,
  newlyUnlocked,
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

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
