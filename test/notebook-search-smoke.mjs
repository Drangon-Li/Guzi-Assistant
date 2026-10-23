import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import * as shared from '../src/shared/notebook.ts'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const source = ts.transpileModule(readFileSync(new URL('../src/main/plugins/notebook/index.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const db = new Database(':memory:')
const mocks = {
  crypto: require('node:crypto'), fs: require('node:fs'), path: require('node:path'),
  electron: { app: { getPath: () => '/unused-notebook-test-user-data' } },
  '../../db/connection.ts': { getDb: () => db },
  '../../db/plugins.ts': { readPluginSetting: () => null, writePluginSetting() {} },
  '@shared/parsing': { localNowSec: () => '2026-10-24T12:00:00' },
  '@shared/notebook': shared
}
const context = { exports: {}, require: (id) => { assert.ok(id in mocks, `Unexpected dependency ${id}`); return mocks[id] } }
vm.runInNewContext(source, context, { filename: 'notebook/index.ts' })
const plugin = context.exports.default
plugin.initTables(db)
const create = (input) => plugin.handlers.create(input).id
const search = (query) => [...plugin.handlers.search(query)]
const body = create({ title: '普通标题', content: '甲'.repeat(100) + '正文末尾关键词' })
const code = create({ title: '代码笔记', content: '示例\n```ts\nconst hiddenCodeNeedle = true\n```' })
const tag = create({ title: '标签笔记', tags: ['quoted"tag', '路径\\标签', '跨 词短语'] })
const international = create({ title: 'ÉTUDE', content: 'ÄPFEL 与中文 Mixed CASE' })
const literal = create({ title: 'literal', content: "100% foo_bar ' OR 1=1 --" })

let failed = 0
function check(name, test) {
  try { test(); console.log(`✓ ${name}`) }
  catch (error) { failed++; console.error(`✗ ${name}: ${error.message}`) }
}
try {
  check('搜索正文80字后的内容，列表仍不携带全文', () => {
    assert.deepEqual(search('正文末尾关键词'), [body])
    assert.ok(plugin.handlers.list().every((note) => !('content' in note)))
    assert.ok(!plugin.handlers.list().find((note) => note.id === body).excerpt.includes('正文末尾关键词'))
  })
  check('搜索代码块中的内容', () => assert.deepEqual(search('hiddenCodeNeedle'), [code]))
  check('标题与正文兼容原Unicode大小写规则', () => {
    assert.deepEqual(search('étude'), [international])
    assert.deepEqual(search('äpfel'), [international])
    assert.deepEqual(search('mixed case'), [international])
  })
  check('标签使用实际值，避免JSON转义和语法命中', () => {
    assert.deepEqual(search('quoted"tag'), [tag])
    assert.deepEqual(search('路径\\标签'), [tag])
    assert.deepEqual(search('["'), [])
  })
  check('多词采用完整短语，去掉首尾空白', () => {
    assert.deepEqual(search('  跨 词短语  '), [tag])
    assert.deepEqual(search('跨 短语'), [])
  })
  check('SQL通配符和引号按字面值匹配', () => {
    assert.deepEqual(search('100%'), [literal])
    assert.deepEqual(search('foo_bar'), [literal])
    assert.deepEqual(search("' OR 1=1 --"), [literal])
  })
  check('空关键词无需全库搜索，结果只有已知笔记ID', () => {
    assert.deepEqual(search('   '), [])
    assert.ok(search('笔记').every((id) => typeof id === 'string'))
  })
  check('更新和删除后搜索反映当前数据库', () => {
    plugin.handlers.update(body, { content: 'replacement' })
    assert.deepEqual(search('正文末尾关键词'), [])
    assert.deepEqual(search('replacement'), [body])
    plugin.handlers.destroy(body)
    assert.deepEqual(search('replacement'), [])
  })
  if (process.env.GUZI_NOTEBOOK_BENCHMARK === '1') {
    db.exec('DELETE FROM p_notebook_note')
    const chunk = '# Heading\n**Alpha** study notes and `code` with ordinary text.\n'
    const content = chunk.repeat(Math.ceil(100 * 1024 / chunk.length)).slice(0, 100 * 1024)
    let editedId
    db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        editedId = create({ title: `Benchmark ${i}`, content: content + (i === 499 ? ' unique-tail-query' : '') })
      }
    })()
    const measure = (read) => {
      const start = performance.now()
      const value = read()
      return { ms: Number((performance.now() - start).toFixed(2)), bytes: Buffer.byteLength(JSON.stringify(value)) }
    }
    console.log('Benchmark', JSON.stringify({
      notes: 500,
      bodyMiB: Number((500 * Buffer.byteLength(content) / 1024 ** 2).toFixed(2)),
      allSummaries: measure(() => plugin.handlers.list()),
      savedNote: measure(() => plugin.handlers.get(editedId)),
      fullTextHitIds: measure(() => search('unique-tail-query'))
    }))
  }
} finally {
  db.close()
}
if (failed) process.exitCode = 1
