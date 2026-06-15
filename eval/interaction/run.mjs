/**
 * 交互捕获决策验证（纯逻辑，无 API）：跑 src/shared/interaction-capture.ts 的 shouldRecord
 * 对标注数据集打分，并单测「同内容二次应跳过」的去重。
 * 用法：node eval/interaction/run.mjs
 */
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const log = (...a) => console.log(...a)

const outfile = resolve(here, '.ic.bundle.mjs')
await esbuild.build({ entryPoints: [resolve(repo, 'src/shared/interaction-capture.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
const { shouldRecord, noteRecorded, newCaptureState } = await import(outfile + `?t=${Date.now()}`)

const ds = JSON.parse(readFileSync(resolve(here, 'dataset.json'), 'utf8'))
const NOW = 1781550000000

let pass = 0
log('标注样本：')
for (const c of ds.cases) {
  const d = shouldRecord(c.content, newCaptureState(), NOW)
  const ok = d.record === c.expect
  if (ok) pass++
  log(`  ${ok ? '✓' : '✗'} ${c.id.padEnd(18)} 期望=${c.expect} 实得=${d.record} (${d.reason})  「${c.content.slice(0, 24)}」`)
}

// 去重单测：同内容第一次记、窗口内第二次跳、窗口外又能记
log('\n去重场景：')
const st = newCaptureState()
const dupText = '明天交季度复盘材料给王经理'
const d1 = shouldRecord(dupText, st, NOW)
if (d1.record) noteRecorded(dupText, st, NOW)
const d2 = shouldRecord(dupText, st, NOW + 60_000) // 1 分钟后（窗口内）
const d3 = shouldRecord(dupText, st, NOW + 20 * 60_000) // 20 分钟后（窗口外）
const dupOk = d1.record === true && d2.record === false && d3.record === true
log(`  ${dupOk ? '✓' : '✗'} 首次记=${d1.record} / 窗口内重复=${d2.record}(${d2.reason}) / 窗口外=${d3.record}`)

const total = ds.cases.length + 1
const got = pass + (dupOk ? 1 : 0)
log(`\n整体：${got}/${total} 通过 (${Math.round((got / total) * 100)}%)`)
writeFileSync(resolve(here, 'last-results.json'), JSON.stringify({ pass: got, total }, null, 2))
if (got < total) process.exit(1)
