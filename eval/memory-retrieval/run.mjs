/**
 * mem0 式可检索记忆验证（在 EShell 自己的栈里，中文）：
 * 每条捕获 → LLM 抽原子中文记忆(+待办) → embedding → 余弦去重 → 建本地记忆库 → 语义检索打分。
 * 用法：node eval/memory-retrieval/run.mjs   （自包含；直连 relay，不注册账号）
 * 覆盖后端：ESHELL_LLM_BASE / ESHELL_LLM_KEY / ESHELL_LLM_MODEL / ESHELL_EMBED_MODEL。
 */
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const BASE = process.env.ESHELL_LLM_BASE || 'https://yunwu.ai/v1'
const KEY = process.env.ESHELL_LLM_KEY || 'sk-qXObeOfiTBUgr9onbpr5cuy0x9TX0XTX1wDtGSYdfL20GlpM'
const MODEL = process.env.ESHELL_LLM_MODEL || 'deepseek-v4-flash'
const EMBED = process.env.ESHELL_EMBED_MODEL || 'text-embedding-3-small'
const log = (...a) => console.log(...a)

const outfile = resolve(here, '.mx.bundle.mjs')
await esbuild.build({ entryPoints: [resolve(repo, 'src/shared/memory-extract.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
const { buildMemoryExtractionInstructions, parseMemoryExtractionOutput, topK, isDuplicate } = await import(outfile + `?t=${Date.now()}`)

const ds = JSON.parse(readFileSync(resolve(repo, 'eval/memory/dataset.json'), 'utf8'))

// 检索金标：query → 命中记忆应含的关键词
const RETRIEVAL = [
  { q: '期末项目什么时候截止', kw: ['6月20', '项目'] },
  { q: '笔试在哪个教室', kw: ['B203'] },
  { q: '面试时间', kw: ['6月19', '面试'] },
  { q: '组会在哪开', kw: ['8308', '组会'] },
  { q: '房租什么时候交', kw: ['6月25', '房租'] }
]

const chat = async (sys, user) => {
  const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0 }) })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error?.message || `chat HTTP ${r.status}`)
  return j.choices?.[0]?.message?.content ?? ''
}
const embed = async (texts) => {
  const r = await fetch(`${BASE}/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED, input: texts }) })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error?.message || `embed HTTP ${r.status}`)
  return j.data.map((d) => d.embedding)
}

const main = async () => {
  const sys = buildMemoryExtractionInstructions(ds.profile)
  const store = [] // {text, entities, todo, embedding}
  let dropped = 0
  for (const c of ds.captures) {
    let mems = []
    try { mems = parseMemoryExtractionOutput(await chat(sys, `(${c.time} · ${c.type}) ${c.text}`)) } catch (e) { log(`[${c.ref}] ERR ${e.message}`) }
    for (const m of mems) {
      const [vec] = await embed([m.text])
      if (isDuplicate(vec, store, 0.9)) { dropped++; continue }
      store.push({ ...m, embedding: vec })
    }
  }

  log(`\n形成 ${store.length} 条原子记忆（去重丢弃 ${dropped}）：`)
  for (const m of store) log(`  • ${m.text}${m.todo ? `  ⟶ 待办: ${m.todo.title} (${m.todo.due_time || '无'})` : ''}`)

  // ---------- 检索 ----------
  log('\n检索：')
  let retrievalOk = 0
  for (const t of RETRIEVAL) {
    const [qv] = await embed([t.q])
    const hits = topK(qv, store, 3)
    const top = hits[0]
    const ok = top && t.kw.some((k) => top.text.includes(k))
    if (ok) retrievalOk++
    log(`  ${ok ? '✓' : '✗'} "${t.q}" → [${top?.score?.toFixed(2)}] ${top?.text ?? '(空)'}`)
  }

  // ---------- 打分 ----------
  const allText = store.map((m) => m.text).join('\n')
  const allTodos = store.filter((m) => m.todo)
  const checks = {}
  checks.atomicMemories = store.length >= 8
  checks.chinese = store.every((m) => /[一-龥]/.test(m.text)) && !/the user|scheduled|reminded/i.test(allText)
  checks.credentialSafe = !allText.includes('482915')
  checks.noiseFiltered = !/五折|优惠券|火锅|编辑 选择|验证码/.test(allText)
  checks.retrieval = retrievalOk >= 4
  checks.todos = ['项目', '笔试', '房租'].every((k) => allTodos.some((m) => m.todo.title.includes(k) || m.text.includes(k)))

  log('\n=== 维度 ===')
  for (const [k, v] of Object.entries(checks)) log(`  ${k.padEnd(15)} ${v ? '✓' : '✗'}`)
  log(`  检索 ${retrievalOk}/${RETRIEVAL.length}`)
  const pass = Object.values(checks).filter(Boolean).length
  log(`\n整体：${pass}/${Object.keys(checks).length} 维度通过`)
  writeFileSync(resolve(here, 'last-results.json'), JSON.stringify({ store: store.map(({ embedding, ...m }) => m), checks, retrievalOk }, null, 2))
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
