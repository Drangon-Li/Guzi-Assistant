// 冒烟测试总入口：自动发现 test/*-smoke.mjs，全部跑完再汇总。
// 取代旧的 40 多条 `&&` 巨链——那种写法中途挂一条后面全不跑，也看不出整体通过率，
// 而且新增用例要同时改 package.json 两处（漏改过 history-performance）。
//
// 用法：
//   node test/run.mjs             跑全部默认用例（无需 API，CI 用这个）
//   node test/run.mjs history      只跑文件名含 history 的用例（可给多个关键词）
//   node test/run.mjs --all        连需要 .env/API 的用例一起跑
//   node test/run.mjs --verbose    打印每个用例的完整输出，而非只打印失败的
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))

// 需要真实 API 凭据（读 .env）的用例：默认跳过，CI 上没有密钥。
const NEEDS_API = new Set(['parser-smoke.mjs', 'assistant-smoke.mjs'])

const args = process.argv.slice(2)
const all = args.includes('--all')
const verbose = args.includes('--verbose')
const filters = args.filter((a) => !a.startsWith('--'))

const files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('-smoke.mjs'))
  .filter((f) => (filters.length ? filters.some((k) => f.includes(k)) : true))
  .sort()

// 显式点名（node test/run.mjs parser）时不跳过需要 API 的用例——用户就是冲它来的。
const selected = files.filter((f) => all || filters.length || !NEEDS_API.has(f))
const skipped = files.filter((f) => !selected.includes(f))

if (!selected.length) {
  console.error(filters.length ? `没有匹配 ${filters.join(' / ')} 的用例` : '没有发现任何用例')
  process.exit(1)
}

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(TEST_DIR, file)], { cwd: dirname(TEST_DIR) })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ file, code, out, ms: Date.now() - started }))
  })
}

const results = []
for (const file of selected) {
  const r = await run(file)
  results.push(r)
  const name = file.replace('-smoke.mjs', '')
  console.log(`${r.code === 0 ? '✓' : '✗'} ${name.padEnd(26)} ${String(r.ms).padStart(6)}ms`)
  if (verbose) console.log(indent(r.out))
}

const failures = results.filter((r) => r.code !== 0)
const totalMs = results.reduce((n, r) => n + r.ms, 0)

// 失败输出统一放到末尾：一次 run 能看到全部失败，不用反复重跑逐个定位。
if (!verbose && failures.length) {
  for (const f of failures) {
    console.log(`\n──── ${f.file} (exit ${f.code}) ────`)
    console.log(indent(f.out))
  }
}

console.log(
  `\n${results.length - failures.length}/${results.length} 通过` +
    (skipped.length ? `，跳过 ${skipped.length} 个需要 API 的用例（--all 一起跑）` : '') +
    `，耗时 ${(totalMs / 1000).toFixed(1)}s`
)
if (failures.length) console.log(`失败：${failures.map((f) => f.file).join(', ')}`)
process.exit(failures.length ? 1 : 0)

function indent(text) {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}
