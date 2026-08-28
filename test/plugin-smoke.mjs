// 纯函数单测：插件 manifest 校验与依赖解析。运行：npm run test:plugin
//
// 这里卡的是插件系统的两条安全边界（表名前缀、通道前缀）和依赖启停的级联正确性。
// 依赖图用合成注册表测，避免测试随真实插件增减而失效；真实注册表只测「自洽」。
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  channelPrefix,
  compareVersions,
  dependentsOf,
  disableChain,
  enableChain,
  findCycle,
  isAvailable,
  missingEnhancements,
  parsePluginChannel,
  pluginChannel,
  pruneEnabled,
  tablePrefix,
  validateManifest,
  validateRegistry
} from '../src/shared/plugin-manifest.ts'
import { PLUGINS, findPlugin } from '../src/shared/plugin-registry.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 前缀约束 ----------

check('表前缀', tablePrefix('timeblock') === 'p_timeblock_')
check('表前缀：连字符转下划线（SQLite 标识符友好）', tablePrefix('my-plugin') === 'p_my_plugin_')
check('通道前缀', channelPrefix('habit') === 'plugin:habit:')
check('拼通道', pluginChannel('habit', 'list') === 'plugin:habit:list')
check('解析通道', eq(parsePluginChannel('plugin:habit:list'), { id: 'habit', action: 'list' }))
check('核心通道不被误判为插件通道', parsePluginChannel('tasks:list') === null)
check('伪装成插件的通道解析失败', parsePluginChannel('plugin:Habit:LIST') === null)
check('多段通道解析失败', parsePluginChannel('plugin:habit:a:b') === null)

// ---------- 版本 ----------

check('版本比较：大于', compareVersions('0.7.0', '0.6.0') === 1)
check('版本比较：小于', compareVersions('0.6.9', '0.7.0') === -1)
check('版本比较：相等', compareVersions('1.2.3', '1.2.3') === 0)
check('版本比较：补位', compareVersions('1.2', '1.2.0') === 0)
const needs07 = { minAppVersion: '0.7.0' }
check('minAppVersion 够', isAvailable(needs07, '0.7.1'))
check('minAppVersion 不够', !isAvailable(needs07, '0.6.5'))

// ---------- manifest 校验 ----------

const base = {
  id: 'demo',
  name: '示例',
  version: '1.0.0',
  minAppVersion: '0.7.0',
  summary: '一句话',
  description: '',
  category: 'planning',
  contributes: {},
  storage: { tables: ['p_demo_thing'] }
}
check('合法 manifest 无错', validateManifest(base).length === 0, validateManifest(base).join('; '))
check(
  '表名没有插件前缀 → 报错（否则卸载会误删核心表）',
  validateManifest({ ...base, storage: { tables: ['tasks'] } }).some((e) => e.includes('必须以 p_demo_ 开头'))
)
check('id 非法 → 报错', validateManifest({ ...base, id: 'Demo Plugin' }).some((e) => e.includes('非法')))
check('版本号不是 x.y.z → 报错', validateManifest({ ...base, version: '1.0' }).some((e) => e.includes('x.y.z')))
check('依赖自己 → 报错', validateManifest({ ...base, dependencies: ['demo'] }).some((e) => e.includes('不能依赖自己')))
check(
  '同一个 id 既硬依赖又软依赖 → 报错',
  validateManifest({ ...base, dependencies: ['a'], enhances: ['a'] }).some((e) => e.includes('取其一'))
)

// ---------- 注册表校验 ----------

check('重复 id → 报错', validateRegistry([base, { ...base, storage: { tables: [] } }]).some((e) => e.includes('重复的插件 id')))
check(
  '两个插件抢同一张表 → 报错',
  validateRegistry([
    base,
    { ...base, id: 'other', storage: { tables: ['p_demo_thing'] } }
  ]).some((e) => e.includes('同时声明'))
)
check(
  '依赖了不存在的插件 → 报错',
  validateRegistry([{ ...base, dependencies: ['ghost'] }]).some((e) => e.includes('不在注册表里'))
)

// 合成依赖图：core ← mid ← leaf，另有一个孤立的 solo
const R = [
  { ...base, id: 'core', storage: { tables: ['p_core_a'] } },
  { ...base, id: 'mid', dependencies: ['core'], storage: { tables: ['p_mid_a'] } },
  { ...base, id: 'leaf', dependencies: ['mid'], storage: { tables: ['p_leaf_a'] } },
  { ...base, id: 'solo', enhances: ['core'], storage: { tables: ['p_solo_a'] } }
]
check('合成注册表自洽', validateRegistry(R).length === 0, validateRegistry(R).join('; '))

// ---------- 成环 ----------

const CYCLE = [
  { ...base, id: 'a', dependencies: ['b'], storage: { tables: ['p_a_x'] } },
  { ...base, id: 'b', dependencies: ['a'], storage: { tables: ['p_b_x'] } }
]
check('检测出依赖环', findCycle(CYCLE) !== null)
check('环被 validateRegistry 拦下', validateRegistry(CYCLE).some((e) => e.includes('成环')))
check('无环时返回 null', findCycle(R) === null)

// ---------- enableChain ----------

check('启用无依赖的插件 → 只有自己', eq(enableChain(R, [], 'core'), ['core']))
check('启用带依赖的插件 → 依赖在前', eq(enableChain(R, [], 'mid'), ['core', 'mid']))
check('链式依赖按拓扑序展开', eq(enableChain(R, [], 'leaf'), ['core', 'mid', 'leaf']))
check('依赖已启用则不重复列出', eq(enableChain(R, ['core'], 'mid'), ['mid']))
check('自己已启用 → 空（无事可做）', eq(enableChain(R, ['core'], 'core'), []))
check('软依赖不牵连启用', eq(enableChain(R, [], 'solo'), ['solo']))
check('注册表里没有的 id → 空', eq(enableChain(R, [], 'ghost'), []))

// ---------- disableChain ----------

check('停用叶子 → 只有自己', eq(disableChain(R, ['core', 'mid', 'leaf'], 'leaf'), ['leaf']))
check('停用被依赖的插件 → 依赖者一起停', eq(disableChain(R, ['core', 'mid'], 'mid'), ['mid']))
check(
  '停用底座 → 整条链级联，依赖者在前',
  eq(disableChain(R, ['core', 'mid', 'leaf'], 'core'), ['leaf', 'mid', 'core'])
)
check('只停已启用的那部分', eq(disableChain(R, ['core', 'mid'], 'core'), ['mid', 'core']))
check('本来就没启用 → 空', eq(disableChain(R, ['core'], 'leaf'), []))
check('软依赖不牵连停用', eq(disableChain(R, ['core', 'solo'], 'core'), ['core']))
check('dependentsOf 只看直接依赖者', eq(dependentsOf(R, 'core'), ['mid']))

// ---------- pruneEnabled ----------

check('自洽集合原样返回', eq(pruneEnabled(R, ['core', 'mid']), ['core', 'mid']))
check('缺依赖的条目被剔除', eq(pruneEnabled(R, ['mid']), []))
check('剔除会传播（core 缺失 → mid、leaf 都掉）', eq(pruneEnabled(R, ['mid', 'leaf']), []))
check('注册表里没有的 id 被剔除', eq(pruneEnabled(R, ['core', 'ghost']), ['core']))

// ---------- missingEnhancements ----------

check('软依赖未启用 → 提示', eq(missingEnhancements(R, [], 'solo'), ['core']))
check('软依赖已启用 → 不提示', eq(missingEnhancements(R, ['core'], 'solo'), []))

// ---------- 真实注册表 ----------

const realErrs = validateRegistry(PLUGINS)
check('内置注册表自洽', realErrs.length === 0, realErrs.join('; '))
check('内置插件不少于 4 个', PLUGINS.length >= 4, `只有 ${PLUGINS.length} 个`)
check('findPlugin 命中', findPlugin('habit')?.name === '打卡')
check('findPlugin 未命中返回 undefined', findPlugin('ghost') === undefined)

for (const p of PLUGINS) {
  check(
    `${p.id}: 主进程实现存在`,
    existsSync(join(root, 'src/main/plugins', p.id, 'index.ts')),
    `缺 src/main/plugins/${p.id}/index.ts`
  )
  check(
    `${p.id}: 渲染层实现存在`,
    existsSync(join(root, 'src/renderer/src/plugins', p.id, 'index.tsx')),
    `缺 src/renderer/src/plugins/${p.id}/index.tsx`
  )
}

// 导航项排序不撞车，否则侧边栏顺序在不同启用组合下不稳定
const orders = PLUGINS.filter((p) => p.contributes.nav).map((p) => p.contributes.nav.order)
check('插件导航 order 互不相同', new Set(orders).size === orders.length)
check('插件导航 order 都 >= 100（100 以下留给核心页）', orders.every((o) => o >= 100))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
