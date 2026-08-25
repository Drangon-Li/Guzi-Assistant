import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureNativeHelperBinary,
  nativeHelperCacheIsCurrent,
  nativeHelperSourceHash
} from '../src/main/native-helper-cache.ts'

const ts = readFileSync(new URL('../src/main/frontapp.ts', import.meta.url), 'utf8')
const collectorSource = readFileSync(new URL('../src/main/native/frontmost-collector.m', import.meta.url), 'utf8')
const oneshotSource = readFileSync(new URL('../src/main/native/frontmost-oneshot.m', import.meta.url), 'utf8')
const nativeSource = `${collectorSource}\n${oneshotSource}`
const source = `${ts}\n${nativeSource}`

const checks = [
  ['使用 NSWorkspace 读取前台应用', /frontmostApplication/.test(source)],
  ['使用 CGWindowList 读取窗口信息', /CGWindowListCopyWindowInfo/.test(source)],
  ['只查询屏幕上的窗口', /kCGWindowListOptionOnScreenOnly/.test(source)],
  ['窗口限定到前台应用 PID', /kCGWindowOwnerPID/.test(source)],
  ['窗口限定到 layer 0', /kCGWindowLayer/.test(source) && /layer\.intValue != 0/.test(source)],
  ['bundle id 来自前台应用', /(?:front|application)\.bundleIdentifier/.test(source)],
  ['窗口标题来自 CGWindowName', /kCGWindowName/.test(source)],
  ['Objective-C 输出 JSON', /NSJSONSerialization dataWithJSONObject/.test(source)],
  ['使用 xcrun clang 构建 helper', /xcrun[\s\S]*clang[\s\S]*AppKit[\s\S]*CoreGraphics/.test(source)],
  ['缓存二进制保留兼容版本并新增长驻版本', /frontmost-context-v3/.test(source) && /frontmost-context-v4/.test(source)],
  ['collector 缓存按源码 hash 校验并重编', /ensureNativeHelperBinary/.test(ts) && /frontmost-collector\.m\?raw/.test(ts)],
  ['导出完整前台上下文', /export async function getFrontmostContext/.test(source)],
  ['完整上下文包含三个约定字段', /name: string[\s\S]*bundleId: string[\s\S]*windowTitle: string/.test(source)],
  ['保留 getFrontmostApp 兼容出口', /export async function getFrontmostApp/.test(source)],
  ['兼容出口复用完整上下文', /getFrontmostApp[\s\S]*await getFrontmostContext\(\)/.test(source)],
  ['失败时返回 null', /catch \{\s*return null\s*\}/.test(source)],
  ['Accessibility 只做浅层焦点观察', /AXObserverCreate/.test(source) && /kAXFocusedUIElementAttribute/.test(source) && !/AXUIElementCopyAttributeNames|AXUIElementCopyAttributeValues/.test(source)],
  ['长驻 collector 输出 JSONL heartbeat', /type.*heartbeat/.test(source) && /lastHeartbeatAtMs/.test(source) && /setInterval/.test(source)],
  ['collector 有界重启与降级状态', /restartCount >= 3/.test(source) && /heartbeat timeout/.test(source) && /degraded/.test(source)],
  ['collector 采集窗口/点击/拖拽/快捷键/输入事件',
    /window_changed/.test(nativeSource) && /NSEventTypeLeftMouse/.test(nativeSource) && /NSEventTypeRightMouse/.test(nativeSource) && /NSEventTypeKeyDown/.test(nativeSource) && /input_activity/.test(nativeSource)],
  ['collector 监听 AX 选择变化但不读取选中文本', /kAXSelectedTextChangedNotification/.test(nativeSource) && !/selectedText|charactersIgnoringModifiers|keyCode/.test(nativeSource)],
  ['输入事件只保存长度和动作类型', /inputLength/.test(nativeSource) && /typing_burst/.test(nativeSource) && !/characters|keyCode/.test(nativeSource)],
  ['读取 AXSubrole 并识别安全输入框', /kAXSubroleAttribute/.test(nativeSource) && /focusedSubrole/.test(nativeSource) && /AXSecureTextField/.test(nativeSource) && /secureRole\(subrole\)/.test(nativeSource)],
  ['输入 burst 锁存安全态和起始窗口', /inputBurstSecure/.test(nativeSource) && /inputBurstSecure\s*=\s*inputBurstSecure\s*\|\|\s*secure/.test(nativeSource) && /BOOL secure = inputBurstSecure/.test(nativeSource) && /inputBurstWindowId/.test(nativeSource)],
  ['AX 查询失败对输入按安全态处理', /activeFocusedIsSecure\(NSRunningApplication \*application\)/.test(nativeSource) && /focusResult != kAXErrorSuccess/.test(nativeSource) && /roleResult != kAXErrorSuccess/.test(nativeSource) && /return YES/.test(nativeSource)],
  ['浏览器只提取 URL host', /kAXURLAttribute/.test(nativeSource) && /urlHostForElement/.test(nativeSource) && /url\.host/.test(nativeSource)],
  ['同标题窗口使用 WindowServer 身份区分', /kCGWindowNumber/.test(nativeSource) && /lastWindowId/.test(nativeSource) && /windowId\s*==\s*lastWindowId/.test(nativeSource)],
  ['无前台应用仍发送 heartbeat', /if \(!application && !\[type isEqualToString:@"heartbeat"\]\) return/.test(nativeSource) && /emitActivity\(@"heartbeat", front/.test(nativeSource)],
  ['Input Monitoring 使用权限预检和实际事件探针', /CGPreflightListenEventAccess\(\)/.test(nativeSource) && /inputMonitoringStatus/.test(nativeSource) && /inputMonitoringObserved/.test(nativeSource) && /@"unknown"/.test(nativeSource)],
  ['collector IPC 拒绝键盘/选中文本字段', /charactersIgnoringModifiers/.test(source) && /selectedText/.test(source) && /return null/.test(source)],
  ['AX 超时进入 degraded/backoff', /kAXErrorCannotComplete/.test(nativeSource) && /activeAccessibilityAvailable/.test(nativeSource) && /noteBundleFailure\(application\)/.test(nativeSource)],
  ['native helper 对 bundle 失败做退避', /bundleBackoffUntil/.test(source) && /noteBundleFailure/.test(source) && /bundleBackedOff/.test(source)],
  ['native helper 不采集完整 URL', !/documentURL|URLString|browserURL/.test(nativeSource)],
  ['collector IPC 拒绝完整 URL 字段', /documentURL/.test(source) && /URLString/.test(source) && /browserURL/.test(source)]
]

for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  assert.ok(ok, name)
}

const cacheRoot = await mkdtemp(join(tmpdir(), 'guzi-native-helper-'))
try {
  const binaryName = 'frontmost-context-v4-ax'
  const binaryPath = join(cacheRoot, binaryName)
  const markerPath = `${binaryPath}.sha256`
  const source = 'fixture-native-source-v2'
  let compileCount = 0
  const compile = async (sourcePath, outputPath) => {
    compileCount += 1
    assert.equal(await readFile(sourcePath, 'utf8'), source)
    await writeFile(outputPath, `compiled-${compileCount}`)
  }

  await writeFile(binaryPath, 'old-cached-helper')
  assert.equal(
    nativeHelperCacheIsCurrent(binaryPath, markerPath, nativeHelperSourceHash(source)),
    false,
    '旧 helper 缺少源码标记时应视为过期'
  )
  await ensureNativeHelperBinary({ directory: cacheRoot, binaryName, source, compile })
  assert.equal(compileCount, 1, '缺失源码标记应触发编译')
  assert.equal(await readFile(binaryPath, 'utf8'), 'compiled-1', '编译后应替换旧 helper')
  assert.equal(await readFile(markerPath, 'utf8'), `${nativeHelperSourceHash(source)}\n`, '编译后应写入源码 hash')

  await ensureNativeHelperBinary({ directory: cacheRoot, binaryName, source, compile })
  assert.equal(compileCount, 1, '源码未变化时应复用 helper')

  await writeFile(markerPath, `${nativeHelperSourceHash('older-source')}\n`)
  await writeFile(binaryPath, 'stale-helper')
  await ensureNativeHelperBinary({ directory: cacheRoot, binaryName, source, compile })
  assert.equal(compileCount, 2, '源码 hash 不匹配时应重新编译')
  assert.equal(await readFile(binaryPath, 'utf8'), 'compiled-2', '重新编译后应替换 stale helper')
} finally {
  await rm(cacheRoot, { recursive: true, force: true })
}

console.log('\n全部通过')
