// 托管后端的 security definer 函数绕过 RLS 改余额/会员：必须对客户端角色收回 EXECUTE，只授予 service_role。
// 新增这类函数却忘了收权限，这里会直接失败。Run: node test/supabase-rpc-privileges-smoke.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const schema = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../server/db/migrations/20261105_restrict_rpc_execute.sql', import.meta.url), 'utf8')
const typeOf = (param) => {
  const type = param.trim().replace(/\s+default\s+.*$/i, '').split(/\s+/).slice(1).join(' ').toLowerCase()
  return type === 'integer' ? 'int' : type
}
const definers = new Map()
for (const m of schema.matchAll(/create or replace function public\.([a-z_]+)\(([^)]*)\)\s*returns[\s\S]*?security definer/gi)) {
  definers.set(m[1], `public.${m[1]}(${m[2].trim() ? m[2].split(',').map(typeOf).join(', ') : ''})`)
}
assert.ok(definers.size >= 6, `expected the billing functions, found ${[...definers.keys()]}`)
const norm = (s) => s.replace(/\s+/g, ' ')
for (const [name, signature] of definers) {
  for (const [label, sql] of [['schema.sql', schema], ['migration', migration]]) {
    assert.ok(norm(sql).includes(`revoke execute on function ${signature} from public, anon, authenticated;`), `${label}: ${name} 未对客户端角色收回 EXECUTE（${signature}）`)
    if (name !== 'handle_new_user')
      assert.ok(norm(sql).includes(`grant execute on function ${signature} to service_role;`), `${label}: ${name} 未授予 service_role`)
  }
}
console.log(`✓ ${definers.size} 个 security definer 函数都已对 public/anon/authenticated 收回 EXECUTE，并只授予 service_role`)
assert.ok(/alter default privileges in schema public revoke execute on functions from public, anon, authenticated;/.test(norm(migration)))
console.log('✓ 以后新建的函数默认不对客户端开放')
for (const caller of ['parse', 'pay-notify']) {
  const source = readFileSync(new URL(`../supabase/functions/${caller}/index.ts`, import.meta.url), 'utf8')
  for (const m of source.matchAll(/(\w+)\.rpc\('([a-z_]+)'/g)) {
    assert.equal(m[1], 'admin', `${caller} 必须用 service_role 客户端调用 ${m[2]}`)
    assert.ok(definers.has(m[2]), `${caller} 调用了未登记的 RPC ${m[2]}`)
  }
}
console.log('✓ 服务端函数只用 service_role 客户端（admin）调用这些 RPC')
console.log('\nAll supabase-rpc-privileges tests passed')
