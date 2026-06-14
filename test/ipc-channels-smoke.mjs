// 一致性测试：preload 白名单（src/shared/ipc-channels.ts）必须与源码实际通道完全一致。
// 漏登记 → 白名单拒绝合法通道、断功能；多登记 → 白名单形同虚设。本测试两头都卡。
// 运行：npm run test:ipc
import { readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../src/shared/ipc-channels.ts'

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
const handlers = uniq(all(read('src/main/ipc.ts'), /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g))
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

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
