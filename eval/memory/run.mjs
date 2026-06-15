/**
 * 记忆整理归纳验证：把 dataset.json 的一天捕获跑过线上 parse 网关（真实模型）整理成「记忆」，按金标打分。
 * 用法：node eval/memory/run.mjs   （自包含；注册一次性账号，消耗 1 积分；清理见 eval/extraction/README.md）
 */
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const URL = process.env.ESHELL_SUPABASE_URL || 'https://rtgypddrknuylecqejmp.supabase.co'
const ANON = process.env.ESHELL_SUPABASE_ANON || 'sb_publishable_KBP637mcafctZX9LczEK3w_S--3WBEq'
const FN = `${URL}/functions/v1`
const log = (...a) => console.log(...a)

const outfile = resolve(here, '.mem.bundle.mjs')
await esbuild.build({ entryPoints: [resolve(repo, 'src/shared/memory-consolidate.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
const { buildConsolidationInstructions, formatConsolidationInput, parseConsolidationOutput } = await import(outfile + `?t=${Date.now()}`)
const { createClient } = await import(resolve(repo, 'node_modules/@supabase/supabase-js/dist/index.mjs'))

const ds = JSON.parse(readFileSync(resolve(here, 'dataset.json'), 'utf8'))
const g = ds.gold

const main = async () => {
  const ts = Date.now(), email = `eshell-val-${ts}@example.com`, password = `Val-${ts}-Aa1`
  const sb = createClient(URL, ANON)
  let token = (await sb.auth.signUp({ email, password })).data?.session?.access_token
  if (!token) token = (await sb.auth.signInWithPassword({ email, password })).data?.session?.access_token
  if (!token) { log('FATAL: 无 token'); process.exit(1) }
  log('test user:', email)

  const instructions = buildConsolidationInstructions(ds.profile)
  const inputText = formatConsolidationInput(ds.captures)
  const body = { action: 'parse_text', instructions, input: [{ role: 'user', content: [{ type: 'input_text', text: inputText }] }] }
  const r = await fetch(`${FN}/parse`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok || j?.error) { log('ERR', j?.error || r.status); process.exit(1) }
  const allowed = new Set(ds.captures.map(c => c.ref))
  const mems = parseConsolidationOutput(j.data.output_text, allowed)

  log(`\n整理出 ${mems.length} 条记忆：`)
  for (const m of mems) {
    log(`  • ${m.title}  refs=[${m.source_refs.join(',')}]  实体=${m.entities.join('/') || '-'}`)
    log(`    摘要：${m.summary}`)
    if (m.todos.length) for (const t of m.todos) log(`    待办：${t.title} (${t.due_time || '无时间'})`)
  }

  // ---------- 打分 ----------
  const allText = JSON.stringify(mems)
  const allTodos = mems.flatMap(m => m.todos)
  const allRefs = new Set(mems.flatMap(m => m.source_refs))
  const checks = {}
  checks.clusterCount = mems.length >= g.memMin && mems.length <= g.memMax
  // 覆盖：每个实体关键词组在某条记忆(title+summary+entities)里命中任一
  const cov = g.entityKeywords.map(grp => mems.some(m => grp.some(k => (m.title + m.summary + m.entities.join('')).includes(k))))
  checks.coverage = cov.every(Boolean)
  // 主题线归并：每条线的关键 refs 至少有一条记忆同时包含其 ≥2 个（或全部，若该线仅1ref）
  const threadOk = Object.values(g.threads).map(refs => mems.some(m => refs.filter(x => m.source_refs.includes(x)).length >= Math.min(2, refs.length)))
  checks.threadGrouping = threadOk.every(Boolean)
  // 待办召回
  const todoHit = g.todoKeywords.map(k => allTodos.some(t => t.title.includes(k)))
  checks.todoRecall = todoHit.every(Boolean)
  // 待办时间
  checks.todoTime = g.todoDates.every(d => allTodos.some(t => (t.due_time || '').startsWith(d)))
  // 去噪：噪声 ref 不进任何 source_refs
  checks.noiseExclusion = g.noiseRefs.every(n => !allRefs.has(n))
  // 凭据安全
  checks.credential = !allText.includes(g.noCredential)

  log('\n=== 维度 ===')
  for (const [k, v] of Object.entries(checks)) log(`  ${k.padEnd(14)} ${v ? '✓' : '✗'}`)
  log(`  覆盖明细: ${cov.map((v, i) => g.entityKeywords[i][0] + (v ? '✓' : '✗')).join(' ')}`)
  log(`  主题线:   ${Object.keys(g.threads).map((k, i) => k + (threadOk[i] ? '✓' : '✗')).join(' ')}`)
  log(`  待办召回: ${g.todoKeywords.map((k, i) => k + (todoHit[i] ? '✓' : '✗')).join(' ')}`)
  const pass = Object.values(checks).filter(Boolean).length
  log(`\n整体：${pass}/${Object.keys(checks).length} 维度通过`)

  writeFileSync(resolve(here, 'last-results.json'), JSON.stringify({ when: new Date(ts).toISOString(), memories: mems, checks }, null, 2))
  await sb.auth.signOut()
  log('→ last-results.json | 清理: delete from auth.users where email like \'eshell-val-%\';')
}
main().catch(e => { console.error(e); process.exit(1) })
