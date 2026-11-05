// 本地模式：托管服务（账号、托管解析网关、计费、应用内反馈）暂停期间，应用不连任何后端，
// 解析全靠用户自己配置的模型。恢复托管服务时把 HOSTED_SERVICE_ENABLED 改回 true，并同步更新这里的断言。
// Run: node test/hosted-service-smoke.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOSTED_BACKEND, HOSTED_SERVICE_ENABLED, resolveBackend } from '../src/shared/hosted-service.ts'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

assert.equal(HOSTED_SERVICE_ENABLED, false, '当前版本是本地模式；恢复托管服务时同步更新本测试')
assert.deepEqual(resolveBackend({}), { url: '', anonKey: '' })
assert.deepEqual(resolveBackend({ url: '', anonKey: '' }), { url: '', anonKey: '' })
console.log('✓ 本地模式下默认不连任何后端')

const selfHosted = { url: 'https://self.example.test', anonKey: 'sb_publishable_self' }
assert.deepEqual(resolveBackend(selfHosted), selfHosted)
assert.deepEqual(resolveBackend(selfHosted, true), selfHosted)
console.log('✓ 构建时指定的自建后端不受开关影响')

assert.deepEqual(resolveBackend({}, true), { url: HOSTED_BACKEND.url, anonKey: HOSTED_BACKEND.anonKey })
console.log('✓ 打开开关即回到维护者的托管后端（恢复路径可用）')

const client = read('src/renderer/src/supabase.ts')
assert.ok(!/supabase\.co|sb_publishable_/.test(client), '渲染层不能再写死托管后端，统一经 resolveBackend')
assert.match(client, /resolveBackend\(/)
console.log('✓ 渲染层只经 resolveBackend 决定连哪个后端')

const parser = read('src/main/parser.ts')
assert.match(parser, /HOSTED_SERVICE_ENABLED && !useCustomModel[\s\S]{0,80}请先登录[\s\S]{0,80}设置 → 助手 → 模型/)
console.log('✓ 本地模式下未配置模型时提示去「设置 → 助手 → 模型」，而不是让人登录')

const welcome = read('src/renderer/src/pages/Welcome.tsx')
const home = read('src/renderer/src/pages/Home.tsx')
assert.match(welcome, /hasBackend \?[\s\S]*登录账号[\s\S]*配置模型/)
assert.match(home, /!hasBackend && !modelReady/)
console.log('✓ 首次引导与首页都把「配置模型」作为本地模式的第一步')

console.log('\nAll hosted-service tests passed')
