// 一致性测试：preload 白名单（src/shared/ipc-channels.ts）必须与源码实际通道完全一致。
// 漏登记 → 白名单拒绝合法通道、断功能；多登记 → 白名单形同虚设。本测试两头都卡。
// 运行：npm run test:ipc
import { readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../src/shared/ipc-channels.ts'
import { PLUGINS } from '../src/shared/plugin-registry.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p) => readFileSync(join(root, p), 'utf-8')
/** 递归读取目录下所有 .ts/.tsx 拼成一个大字符串，避免漏文件 */
const readDir = (rel) =>
  readdirSync(join(root, rel), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => readFileSync(join(e.parentPath ?? e.path, e.name), 'utf-8'))
    .join('\n')
const all = (src, re) => [...src.matchAll(re)].map((m) => m[1])
const uniq = (a) => [...new Set(a)].sort()
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const subset = (a, b) => a.every((x) => b.includes(x))

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

const invoke = uniq([...INVOKE_CHANNELS])
const event = uniq([...EVENT_CHANNELS])

// 1) 主进程 ipcMain.handle 注册的通道（\s 跨行匹配 assistant:* 那种换行写法）
// 主进程注册按领域拆在 src/main/ipc/ 下，入口 src/main/ipc.ts 只负责挂上
const handlers = uniq(all(read('src/main/ipc.ts') + readDir('src/main/ipc'), /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g))
check(
  'INVOKE 清单 == ipcMain.handle 注册集',
  eq(handlers, invoke),
  `源码=${JSON.stringify(handlers)} 清单=${JSON.stringify(invoke)}`
)

const rendererSrc = readDir('src/renderer')
const mainSrc = readDir('src/main')

// 2) 渲染层 api.ts 调用的 invoke 通道必须都在白名单内
const apiCalls = uniq(all(rendererSrc, /inv<[^>]*>\(\s*['"]([^'"]+)['"]/g))
check('渲染层调用的 invoke 通道 ⊆ 白名单', subset(apiCalls, invoke), `越界=${JSON.stringify(apiCalls.filter((c) => !invoke.includes(c)))}`)
check('解析到的 invoke 调用有效', apiCalls.length >= 20, `仅解析到 ${apiCalls.length} 个`)

// 3) 主进程广播的事件通道必须都在白名单内
const broadcasts = uniq(all(mainSrc, /broadcast\(\s*['"]([^'"]+)['"]/g))
check('主进程 broadcast 通道 ⊆ EVENT 白名单', subset(broadcasts, event), `越界=${JSON.stringify(broadcasts.filter((c) => !event.includes(c)))}`)

// 4) 渲染层订阅的事件通道必须都在白名单内（全 renderer 目录扫描，含 PreviewCard/Assistant）
const subs = uniq(all(rendererSrc, /\.on\(\s*['"]([^'"]+)['"]/g))
check('渲染层 .on 订阅 ⊆ EVENT 白名单', subset(subs, event) && subs.length > 0, `订阅=${JSON.stringify(subs)}`)

// 5) 无重复登记
check('INVOKE 清单无重复', invoke.length === INVOKE_CHANNELS.length)
check('EVENT 清单无重复', event.length === EVENT_CHANNELS.length)

// ---------- 插件通道 ----------
// 插件通道不逐条登记（启用时才动态注册），白名单改为按形状放行。放宽了白名单就必须
// 补齐这几条，否则「preload 白名单」这道防线会在无人察觉的情况下形同虚设。

// 6) 白名单本身不能被插件通道污染：plugin:* 一条都不该出现在静态清单里
check(
  'INVOKE/EVENT 静态清单里没有 plugin:* 通道',
  !invoke.some((c) => c.startsWith('plugin:')) && !event.some((c) => c.startsWith('plugin:')),
  '插件通道是动态注册的，写进静态清单说明有人绕开了 pluginChannel()'
)

// 7) 主进程不许出现 plugin: 字面量通道。必须走 pluginChannel(id, action)——
//    那里会带上注册表里的 id，手写字面量就绕过了 id 校验。
const literalPluginChannels = uniq(all(mainSrc, /['"](plugin:[^'"]*)['"]/g))
check(
  '主进程没有手写的 plugin: 字面量通道',
  literalPluginChannels.length === 0,
  `发现=${JSON.stringify(literalPluginChannels)}（应改用 pluginChannel()）`
)

// 8) preload 必须真的做了插件通道的形状 + id 校验，而不是无条件放行
const preloadSrc = read('src/preload/index.ts')
check('preload 校验插件通道形状', preloadSrc.includes('parsePluginChannel'))
check('preload 按注册表 id 收口', preloadSrc.includes('PLUGIN_IDS') && preloadSrc.includes('PLUGINS'))
check(
  'preload 仍然拒绝白名单外的通道',
  /未授权的 IPC 通道/.test(preloadSrc),
  'reject 分支被删了'
)

// 9) 每个插件模块导出的 action 名都能拼成合法通道（否则 preload 会拒掉自家的调用）
const pluginModules = readdirSync(join(root, 'src/main/plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
check('至少有一个插件实现', pluginModules.length > 0)

const actionRe = /^[a-z0-9-]+$/
let badActions = []
for (const id of pluginModules) {
  const src = readFileSync(join(root, 'src/main/plugins', id, 'index.ts'), 'utf-8')
  // handlers 块里的 key：'foo-bar': (…) 或 foo: (…)
  const block = src.slice(src.indexOf('handlers:'))
  for (const m of block.matchAll(/^\s{4}'?([a-zA-Z][a-zA-Z0-9-]*)'?:\s*\(/gm)) {
    if (!actionRe.test(m[1])) badActions.push(`${id}:${m[1]}`)
  }
}
check(
  '插件 action 名都是 [a-z0-9-]+（parsePluginChannel 只认这个形状）',
  badActions.length === 0,
  `非法=${JSON.stringify(badActions)}`
)

// 10) main/plugins 下的实现必须与 manifest 注册表一一对应
const declared = uniq([...PLUGINS.map((p) => p.id)])
check(
  '插件实现目录 == manifest 注册表',
  eq(uniq(pluginModules.filter((d) => d !== 'types' && d !== 'counters')), declared),
  `目录=${JSON.stringify(uniq(pluginModules))} 注册表=${JSON.stringify(declared)}`
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
