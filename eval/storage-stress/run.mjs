/**
 * 存储/检索压力测试（#路线图 1a/1d）：验证所选「纯 TS 暴力余弦」记忆检索在规模下的**延迟 + 准确度**，
 * 给出「存储上限/检索效果」的真实数字（个人量级是否够用，何时需换 sqlite-vec/ANN）。
 * 真实 needle/query 嵌入（relay）+ 合成 distractor 向量，规模 N=1k/5k/20k。
 * 用法：node eval/storage-stress/run.mjs
 */
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const BASE = process.env.ESHELL_LLM_BASE || 'https://yunwu.ai/v1'
const KEY = process.env.ESHELL_LLM_KEY || 'sk-qXObeOfiTBUgr9onbpr5cuy0x9TX0XTX1wDtGSYdfL20GlpM'
const EMBED = process.env.ESHELL_EMBED_MODEL || 'text-embedding-3-small'
const log = (...a) => console.log(...a)

const outfile = resolve(here, '.ss.bundle.mjs')
await esbuild.build({ entryPoints: [resolve(repo, 'src/shared/memory-extract.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
const { topK, cosineSim } = await import(outfile + `?t=${Date.now()}`)

const embed = async (texts) => {
  const r = await fetch(`${BASE}/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED, input: texts }) })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error?.message || `embed ${r.status}`)
  return j.data.map((d) => d.embedding)
}

// 真实 needle 记忆 + 查询（target=应命中的 needle 下标）
const NEEDLES = [
  '林动的数据库系统期末项目报告6月20日23:59截止，提交教学网',
  '林动6月18日14:00在理科楼B203参加复试笔试，需带学生证',
  '林动6月19日上午9:30在行政楼305参加面试',
  '周三6月17日下午3点在C8-8308象山会议室开组会讨论中期检查PPT',
  '林动需6月25日前向房东支付本月房租',
  '林动需把实验室设备报销单交给王老师签字',
  '林动有快递到驿站，取件码A-7，三天内领取',
  '王老师要求期末项目包含完整测试报告和说明文档'
]
const QUERIES = [
  { q: '项目什么时候截止', target: 0 },
  { q: '笔试在哪个教室', target: 1 },
  { q: '面试几点', target: 2 },
  { q: '组会在哪', target: 3 },
  { q: '房租截止', target: 4 }
]

function randVec(dim) {
  const v = new Array(dim)
  let n = 0
  for (let i = 0; i < dim; i++) { const x = Math.random() - 0.5; v[i] = x; n += x * x }
  const inv = 1 / Math.sqrt(n)
  for (let i = 0; i < dim; i++) v[i] *= inv
  return v
}

const main = async () => {
  log('嵌入真实 needle/query…')
  const needleVecs = await embed(NEEDLES)
  const queryVecs = await embed(QUERIES.map((x) => x.q))
  const dim = needleVecs[0].length
  log(`维度 ${dim}\n`)

  log('| N(总记忆) | 建库(ms) | 单次检索 avg(ms) | top-1 命中 | top-3 命中 | 估算内存(MB) |')
  log('|---|---|---|---|---|---|')
  for (const N of [1000, 5000, 20000]) {
    const t0 = Date.now()
    const store = []
    for (let i = 0; i < N; i++) store.push({ id: `d${i}`, text: '', embedding: randVec(dim) })
    NEEDLES.forEach((t, i) => store.push({ id: `n${i}`, text: t, embedding: needleVecs[i] }))
    const buildMs = Date.now() - t0

    let t1 = 0, hit1 = 0, hit3 = 0
    for (let qi = 0; qi < QUERIES.length; qi++) {
      const qv = queryVecs[qi]
      const s = Date.now()
      const hits = topK(qv, store, 3)
      t1 += Date.now() - s
      const ids = hits.map((h) => h.id)
      const tgt = `n${QUERIES[qi].target}`
      if (ids[0] === tgt) hit1++
      if (ids.includes(tgt)) hit3++
    }
    const memMB = Math.round(((N + NEEDLES.length) * dim * 8) / 1e6)
    log(`| ${N + NEEDLES.length} | ${buildMs} | ${(t1 / QUERIES.length).toFixed(1)} | ${hit1}/${QUERIES.length} | ${hit3}/${QUERIES.length} | ~${memMB} |`)
  }
  log('\n说明：distractor 为随机单位向量（真实记忆彼此更分散，命中只会更好），延迟为全量暴力余弦。')
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
