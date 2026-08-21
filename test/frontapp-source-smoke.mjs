import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/main/frontapp.ts', import.meta.url), 'utf8')

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
  ['导出完整前台上下文', /export async function getFrontmostContext/.test(source)],
  ['完整上下文包含三个约定字段', /name: string[\s\S]*bundleId: string[\s\S]*windowTitle: string/.test(source)],
  ['保留 getFrontmostApp 兼容出口', /export async function getFrontmostApp/.test(source)],
  ['兼容出口复用完整上下文', /getFrontmostApp[\s\S]*await getFrontmostContext\(\)/.test(source)],
  ['失败时返回 null', /catch \{\s*return null\s*\}/.test(source)],
  ['Accessibility 只做浅层焦点观察', /AXObserverCreate/.test(source) && /kAXFocusedUIElementAttribute/.test(source) && !/AXUIElementCopyAttributeNames|AXUIElementCopyAttributeValues/.test(source)],
  ['长驻 collector 输出 JSONL heartbeat', /type.*heartbeat/.test(source) && /lastHeartbeatAtMs/.test(source) && /setInterval/.test(source)],
  ['collector 有界重启与降级状态', /restartCount >= 3/.test(source) && /heartbeat timeout/.test(source) && /degraded/.test(source)],
  ['不采集键盘事件', !/CGEventTap|NSEvent\.addGlobalMonitor|keyDown|keyUp/.test(source)],
  ['不采集 URL', !/documentURL|URLString|browserURL/.test(source)]
]

for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  assert.ok(ok, name)
}

console.log('\n全部通过')
