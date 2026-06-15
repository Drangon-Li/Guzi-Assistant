/**
 * 抽取算法验证：把 dataset.json 跑过线上 parse 网关（真实模型），按金标打分。
 * 用法：node eval/extraction/run.mjs
 *   - 自包含：用 esbuild 临时打包 src/shared/parsing.ts（真实算法代码），无需先 build。
 *   - 会注册一个一次性 Supabase 账号并消耗少量积分；跑完用下方 SQL 清理：
 *       delete from auth.users where email like 'eshell-val-%';
 *   - 覆盖后端：环境变量 ESHELL_SUPABASE_URL / ESHELL_SUPABASE_ANON。
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
const HINT = '以下是用户粘贴/输入的文本，请提取其中的行动项。'
const log = (...a) => console.log(...a)

// 真实算法代码：临时打包 src/shared/parsing.ts 再 import
const outfile = resolve(here, '.parsing.bundle.mjs')
await esbuild.build({ entryPoints: [resolve(repo, 'src/shared/parsing.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
const { buildInstructions, parseModelOutput } = await import(outfile + `?t=${Date.now()}`)
const { createClient } = await import(resolve(repo, 'node_modules/@supabase/supabase-js/dist/index.mjs'))

const ds = JSON.parse(readFileSync(resolve(here, 'dataset.json'), 'utf8'))
const pad = n => String(n).padStart(2, '0')
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const resolveDate = g => {
  if (g.dateAbs) return g.dateAbs
  if (g.dateRel?.startsWith('+')) { const d = new Date(); d.setDate(d.getDate() + parseInt(g.dateRel)); return dstr(d) }
  if (g.dateRel?.startsWith('wd:')) { const wd = +g.dateRel.slice(3); const d = new Date(); const diff = (wd - d.getDay() + 7) % 7 || 7; d.setDate(d.getDate() + diff); return dstr(d) }
  return null
}

const main = async () => {
  const ts = Date.now(), email = `eshell-val-${ts}@example.com`, password = `Val-${ts}-Aa1`
  const sb = createClient(URL, ANON)
  let token = (await sb.auth.signUp({ email, password })).data?.session?.access_token
  if (!token) token = (await sb.auth.signInWithPassword({ email, password })).data?.session?.access_token
  if (!token) { log('FATAL: 无 token'); process.exit(1) }
  log('test user:', email, '\n')

  const instructions = buildInstructions(ds.profile, [], '')
  const results = [], dim = {}
  for (const s of ds.samples) {
    const body = { action: 'parse_text', instructions, input: [{ role: 'user', content: [{ type: 'input_text', text: `${HINT}\n\n=== 用户提交的内容 ===\n${s.text}` }] }] }
    let items = [], err = null
    try {
      const r = await fetch(`${FN}/parse`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok || j?.error) err = j?.error || `HTTP ${r.status}`
      items = j?.data?.output_text ? parseModelOutput(j.data.output_text) : []
    } catch (e) { err = String(e) }

    const g = s.gold, date = resolveDate(g)
    const actionable = items.filter(i => i.belongs_to_user !== 'no')
    const c = {}
    c.detection = g.task ? actionable.length >= 1 : items.every(i => i.belongs_to_user === 'no' || i.suggested_action === 'ignore') && actionable.length === 0
    if (g.belongs) c.belongs = items.some(i => i.belongs_to_user === g.belongs)
    if (g.notAutoAdd) c.notAutoAdd = !items.some(i => i.suggested_action === 'add' && i.confidence >= 0.8)
    if (date) c.time = items.some(i => (i.start_time || '').startsWith(date) || (i.due_time || '').startsWith(date))
    if (g.multiMin) c.multi = items.length >= g.multiMin
    if (g.noCredential) c.credential = !items.some(i => JSON.stringify([i.title, i.notes, i.evidence]).includes(g.noCredential))
    if (g.locationContains) c.location = items.some(i => (i.location || '').includes(g.locationContains))
    const pass = Object.values(c).every(Boolean)
    for (const [k, v] of Object.entries(c)) { dim[k] = dim[k] || { ok: 0, n: 0 }; dim[k].n++; if (v) dim[k].ok++ }
    results.push({ id: s.id, items, checks: c, pass, err })
    log(`${pass ? '✅' : '❌'} ${s.id.padEnd(18)} items=${items.length} ${err ? 'ERR=' + err : ''} | ${Object.entries(c).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' ')}`)
  }

  const overall = results.filter(r => r.pass).length
  log('\n=== 汇总 ===')
  log(`整体: ${overall}/${results.length} (${Math.round(overall / results.length * 100)}%)`)
  for (const [k, { ok, n }] of Object.entries(dim)) log(`  ${k.padEnd(11)} ${ok}/${n} (${Math.round(ok / n * 100)}%)`)
  writeFileSync(resolve(here, 'last-results.json'), JSON.stringify({ when: new Date(ts).toISOString(), overall: `${overall}/${results.length}`, dim, results }, null, 2))
  await sb.auth.signOut()
  log('\n→ last-results.json  | 清理: delete from auth.users where email like \'eshell-val-%\';')
}
main().catch(e => { console.error(e); process.exit(1) })
