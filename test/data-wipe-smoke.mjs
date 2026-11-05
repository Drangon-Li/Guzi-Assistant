import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const source = (name) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
function load(name, mocks = {}) {
  const exports = {}
  const code = ts.transpileModule(source(name), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(code, { exports, require: (id) => id in mocks ? mocks[id] : require(id) }, { filename: name })
  return exports
}

function fixture() {
  const db = new Database(':memory:')
  db.exec(source('main/db/connection').match(/db\.exec\(`([\s\S]*?)`\)/)[1])
  for (const id of ['pomodoro', 'timeblock', 'habit', 'achievement', 'notebook']) {
    db.exec(source(`main/plugins/${id}/index`).match(/db\.exec\(`([\s\S]*?)`\)/)[1])
  }
  db.exec(`
    CREATE TABLE history_segments (id TEXT PRIMARY KEY);
    CREATE TABLE history_summaries (id TEXT PRIMARY KEY);
    CREATE TABLE activity_intervals (id TEXT PRIMARY KEY);
    CREATE TABLE p_disabled_content (id TEXT PRIMARY KEY, content TEXT);
    CREATE VIRTUAL TABLE sources_fts USING fts5(source_id UNINDEXED, body, tokenize='trigram');
  `)
  const tables = db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name != 'settings'").all()
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all()
    const fields = cols.filter((col) => col.pk || (col.notnull && col.dflt_value === null))
    const values = fields.map((col) => /INT/i.test(col.type) ? 1 : `private-${col.name}`)
    db.prepare(`INSERT INTO "${name}" (${fields.map((col) => `"${col.name}"`).join(',')}) VALUES (${values.map(() => '?').join(',')})`).run(...values)
  }
  db.prepare('INSERT INTO sources_fts(source_id,body) VALUES (?,?)').run('private-id', 'confidential source text')
  const settings = {
    theme: 'dark',
    apiKey: 'fixture-key',
    enabledPlugins: '["pomodoro","notebook"]',
    'plugin:notebook:prefs': '{"fontScale":1.2}',
    'plugin:pomodoro:prefs': '{"autoStart":true}',
    'plugin:pomodoro:continuation': '{"taskTitle":"private title"}'
  }
  const insert = db.prepare('INSERT INTO settings(key,value) VALUES (?,?)')
  for (const [key, value] of Object.entries(settings)) insert.run(key, value)
  const maintenance = load('main/db/maintenance', {
    './connection.ts': { getDb: () => db },
    './work-records.ts': {},
    './plugins.ts': { pluginSettingKey: (id, key) => `plugin:${id}:${key}` },
    '@shared/parsing': {}
  })
  return { db, tables, settings, maintenance }
}

{
  const { db, tables, settings, maintenance } = fixture()
  try {
    const beforeSchema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all()
    maintenance.wipeAll()
    for (const { name } of tables) assert.equal(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n, 0, name)
    assert.equal(db.prepare('SELECT count(*) AS n FROM sources_fts').get().n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM sources_fts_idx').get().n, 0)
    for (const [key, value] of Object.entries(settings)) {
      const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
      if (key === 'plugin:pomodoro:continuation') assert.equal(row, undefined)
      else assert.equal(row.value, value)
    }
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all(), beforeSchema)
    db.prepare('INSERT INTO sources_fts(source_id,body) VALUES (?,?)').run('new', 'new searchable text')
    assert.equal(db.prepare("SELECT count(*) AS n FROM sources_fts WHERE sources_fts MATCH 'searchable'").get().n, 1)
    console.log('✓ 清全部核心/停用插件内容、FTS、对话、语音和计数；偏好和schema保留，FTS可继续使用')
  } finally { db.close() }
}

{
  const { db, tables, maintenance } = fixture()
  try {
    db.exec("CREATE TRIGGER fail_wipe BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT, 'test rollback'); END;")
    assert.throws(() => maintenance.wipeAll(), /test rollback/)
    for (const { name } of tables) assert.equal(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n, 1, name)
    assert.equal(db.prepare('SELECT count(*) AS n FROM sources_fts').get().n, 1)
    assert.ok(db.prepare("SELECT value FROM settings WHERE key='plugin:pomodoro:continuation'").get())
    console.log('✓ 清表途中失败整笔事务回滚，内容与运行上下文不会部分提交')
  } finally { db.close() }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'guzi-wipe-fixture-'))
  try {
    const contentNames = ['shots', 'voice-notes', 'notebook-assets', 'history-v2', 'dropbox']
    for (const name of contentNames) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(join(dir, name, 'private-content'), 'private')
    }
    writeFileSync(join(dir, 'screen-sense-debug.log'), 'private title')
    writeFileSync(join(dir, 'screen-sense-debug.log.1'), 'rotated private title')
    mkdirSync(join(dir, 'pet'))
    writeFileSync(join(dir, 'pet', 'prefs.json'), '{"scale":1}')
    for (const name of ['eshell.db', '.env', 'update-check.json', 'external-import.pdf']) writeFileSync(join(dir, name), 'keep')
    await load('main/content-files').clearUserContentFiles(dir)
    for (const name of [...contentNames, 'screen-sense-debug.log', 'screen-sense-debug.log.1']) assert.equal(existsSync(join(dir, name)), false, name)
    for (const name of ['eshell.db', '.env', 'update-check.json', 'external-import.pdf', 'pet/prefs.json']) assert.ok(existsSync(join(dir, name)), name)
    console.log('✓ 只删除应用管理的截图/录音/笔记图片/历史/投递清单/日志，保留配置和外部导入原件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
