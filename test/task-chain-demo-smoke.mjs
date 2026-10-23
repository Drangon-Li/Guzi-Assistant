import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import ts from 'typescript'
import Database from 'better-sqlite3'

// Compile the actual domain modules with only the connection and external effects replaced.
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'guzi-task-demo-'))
const modules = [
  'src/shared/parsing.ts', 'src/shared/work-report.ts', 'src/shared/detection-gate.ts',
  'src/shared/phash.ts', 'src/shared/fts-query.ts', 'src/shared/task-reminder.ts',
  'src/main/db/tasks.ts', 'src/main/db/detections.ts', 'src/main/db/sources.ts',
  'src/main/db-migrations.ts', 'src/main/task-ingest.ts', 'src/main/detection-cards.ts', 'src/main/assistant.ts',
  'src/main/content-lifecycle.ts'
]
const stubs = {
  'src/main/db/connection.ts': 'export const getDb = () => globalThis.demoDb; export const isFtsReady = () => false;',
  'src/main/shotvault.ts': 'export const deleteShot = () => {}; export const finalizeShot = () => {};',
  'src/main/capture.ts': 'export const excerptOf = (s) => s.slice(0,80);',
  'src/main/windows.ts': 'export const broadcast = () => {}; export const debugEvent = () => {}; export const showPreview = (p) => globalThis.demoPreviews.push(p);',
  'src/main/parser.ts': 'export const callModel = async () => globalThis.demoOutput;',
  'src/main/pet/controller.ts': 'export const applyExternalPetReaction = () => {}; export const applyExternalPetSay = () => {};',
  'src/main/plugins/index.ts': 'export const assistantActions = () => ""; export const assistantContext = () => ""; export const runAssistantAction = () => null;',
  'src/main/db.ts': `export * from './db/tasks'; export * from './db/detections'; export * from './db/sources';
    export const getProfile = () => ({ name:'演示用户', nicknames:[], accounts:[], identity:'worker', org:'', group:'' });
    export const personalMemoryText = () => '';`
}
const allPaths = new Set([...modules, ...Object.keys(stubs)])
function compile(name, source) {
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  code = code.replace(/(from\s*['"])([^'"]+)(['"])/g, (_, before, spec, after) => {
    if (!spec.startsWith('.') && !spec.startsWith('@shared/')) return before + spec + after
    let target = spec.startsWith('@shared/') ? `src/shared/${spec.slice(8)}` : resolve('/', dirname(name), spec).slice(1)
    if (!target.endsWith('.ts')) target += '.ts'
    assert.ok(allPaths.has(target), `unmocked dependency ${name}: ${spec}`)
    return before + pathToFileURL(join(temp, target.replace(/\.ts$/, '.mjs'))).href + after
  })
  const dest = join(temp, name.replace(/\.ts$/, '.mjs'))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, code)
}
let db
try {
  for (const name of modules) compile(name, readFileSync(join(root, name), 'utf8'))
  for (const [name, source] of Object.entries(stubs)) compile(name, source)
  const load = (name) => import(pathToFileURL(join(temp, name.replace(/\.ts$/, '.mjs'))))
  const parsing = await load('src/shared/parsing.ts')
  const tasks = await load('src/main/db/tasks.ts')
  const detections = await load('src/main/db/detections.ts')
  const cards = await load('src/main/detection-cards.ts')
  const assistant = await load('src/main/assistant.ts')
  const ingest = await load('src/main/task-ingest.ts')
  const sources = await load('src/main/db/sources.ts')
  const { dueReminders, localIso } = await load('src/shared/task-reminder.ts')
  const { migrateDetectionItems } = await load('src/main/db-migrations.ts')
  const file = join(temp, 'demo.sqlite')
  db = globalThis.demoDb = new Database(file)
  globalThis.demoPreviews = []
  db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT, excerpt TEXT, content TEXT, file_path TEXT, created_at TEXT, deleted INTEGER DEFAULT 0);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, source_id TEXT, title TEXT, item_type TEXT, belongs_to_user TEXT, belonging_reason TEXT, user_role TEXT,
      start_time TEXT, due_time TEXT, location TEXT, priority TEXT, confidence REAL, suggested_action TEXT, evidence TEXT, notes TEXT, duplicate_of TEXT,
      status TEXT, feedback TEXT, tags TEXT, checklist TEXT, remind_offset_min INTEGER, reminded_at TEXT, snoozed_until TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE detections (id TEXT PRIMARY KEY, title TEXT, time_iso TEXT, deadline INTEGER, source_text TEXT, hits TEXT, app TEXT, status TEXT, created_at TEXT);
    CREATE TABLE detection_notes (id TEXT, detection_id TEXT, title TEXT, note TEXT, created_at TEXT);`)
  db.prepare("INSERT INTO detections VALUES ('legacy','旧行日程',?,1,'旧来源','[]','Demo','new',?)").run(localIso(Date.now()+86400000), parsing.localNow())
  migrateDetectionItems(db)
  migrateDetectionItems(db)
  assert.equal(detections.getDetection('legacy').item, null)
  const mk = (title, patch = {}) => parsing.normalizeItem({ title, belongs_to_user:'uncertain', confidence:0.8, due_time:'2099-10-18T23:59', ...patch })
  const first = cards.acceptLocal({ item:mk('提交论文'), sourceText:'演示通知：提交论文' })
  const second = cards.acceptLocal({ item:mk('缴纳学费'), sourceText:'演示通知：缴纳学费' })
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, false)
  assert.equal(cards.acceptLocal({ item:mk('提交论文'), sourceText:'重复通知' }).duplicate, true)
  assert.equal(tasks.findDuplicateTitle('提交论文', null, '2099-10-19T23:59'), null)
  console.log('✓ 同日23:59不同事项分别入库；同名同时间拦重；同名不同时间保留')

  const prev = mk('上一轮候选')
  const current = mk('本轮新候选')
  const noSource = parsing.resolveAddPicks([{candidate:1,patch:null,force:false}], [prev], [current])
  assert.deepEqual(noSource, [])
  for (const [source, expected] of [['previous',prev],['current',current]]) {
    const picks = parsing.resolveAddPicks([{source,candidate:1,patch:null,force:false}], [prev], [current])
    assert.equal(picks[0].item.title, expected.title)
    assert.equal(picks[0].source, source)
  }
  globalThis.demoOutput = JSON.stringify({ reply:'已添加', candidates:[current], add:[{source:'current', candidate:1}] })
  const turn = await assistant.assistantChat({ history:[{role:'user',content:'本轮独立原文'}], candidates:{sourceText:'上一轮原文',items:[prev]} })
  assert.equal(turn.added[0].title, current.title)
  assert.equal(turn.added[0].source, 'current')
  assert.equal(sources.getSource(tasks.getTask(turn.added[0].taskId).sourceId).content, '本轮独立原文')
  assistant.notifyQuickChatResult(turn, '本轮独立原文')
  assert.equal(globalThis.demoPreviews.length, 0, '本轮已添加候选不再弹待确认卡')
  globalThis.demoOutput = JSON.stringify({ reply:'已添加', candidates:[mk('另一个新候选')], add:[{source:'previous',candidate:1}] })
  const prevTurn = await assistant.assistantChat({ history:[{role:'user',content:'加上一轮'}], candidates:{sourceText:'上一轮原文',items:[prev]} })
  assert.equal(prevTurn.added[0].source, 'previous')
  assert.equal(sources.getSource(tasks.getTask(prevTurn.added[0].taskId).sourceId).content, '上一轮原文')
  assistant.notifyQuickChatResult(prevTurn, '加上一轮')
  assert.equal(globalThis.demoPreviews.length, 1, '添加上一轮仍应展示本轮未确认候选')
  globalThis.demoOutput = JSON.stringify({reply:'已添加',candidates:[mk('歧义新候选')],add:[{candidate:1}]})
  const beforeAmbiguous = tasks.listTasks().length
  const ambiguousTurn = await assistant.assistantChat({history:[{role:'user',content:'提醒我新任务'}],candidates:{sourceText:'旧来源',items:[mk('歧义旧候选')]}})
  assert.equal(ambiguousTurn.added.length,0)
  assert.equal(tasks.listTasks().length,beforeAmbiguous)
  assert.ok(ambiguousTurn.reply.includes('尚未添加'))
  console.log('✓ 新旧候选同时存在按source精确添加，正确保存原文并处理后台剩余候选')

  const eventTime = localIso(Date.now()+5*60_000)
  const pendingSource = sources.createSource({ type:'text_input', excerpt:'demo', content:'demo', filePath:null })
  const pending = ingest.createTaskFromItem(pendingSource.id, mk('被动未确认',{start_time:eventTime,due_time:null}), 'pending')
  const stillPassive = ingest.createTaskFromItem(pendingSource.id, mk('被动uncertain',{start_time:eventTime,due_time:null}), 'scheduled')
  tasks.updateTask(pending.id,{status:'scheduled'})
  assert.equal(tasks.getTask(pending.id).belongsToUser,'uncertain', '任意状态变更不隐式改判归属')
  tasks.updateTask(pending.id,{status:'pending'})
  assert.ok(!tasks.listReminderCandidates().some(t => [pending.id,stillPassive.id].includes(t.id)))
  tasks.confirmTasks([pending.id])
  assert.equal(tasks.getTask(pending.id).belongsToUser,'yes')
  const reminderOpts = {enabled:true,defaultOffsetMin:5,catchupWindowMin:120}
  assert.ok(dueReminders(tasks.listReminderCandidates(),reminderOpts,new Date()).some(r => r.taskId===pending.id))
  const accepted = cards.acceptLocal({item:mk('主动接受uncertain',{start_time:eventTime,due_time:null}),sourceText:'demo'})
  assert.equal(tasks.getTask(accepted.taskId).belongsToUser,'yes')
  assert.ok(dueReminders(tasks.listReminderCandidates(),reminderOpts,new Date()).some(r => r.taskId===accepted.taskId))
  assert.equal(tasks.getTask(stillPassive.id).belongsToUser,'uncertain')
  const batchA = ingest.createTaskFromItem(pendingSource.id,mk('批量确认有时间'), 'pending')
  const batchB = ingest.createTaskFromItem(pendingSource.id,mk('批量确认无时间',{due_time:null}), 'pending')
  tasks.confirmTasks([batchA.id,batchB.id])
  assert.equal(tasks.getTask(batchA.id).status,'scheduled')
  assert.equal(tasks.getTask(batchB.id).status,'not_started')
  assert.equal(tasks.getTask(batchB.id).belongsToUser,'yes')
  console.log('✓ explicit accept/单条批量confirm将uncertain认领为本人并进入提醒，被动uncertain继续过滤')

  const full = mk('完整会议候选',{ item_type:'meeting',start_time:'2099-10-20T10:00',due_time:'2099-10-20T11:00',location:'C8-8308',priority:'high',notes:['携带身份证'],tags:['研究'],evidence:['10月20日来C8-8308'] })
  const built = cards.buildDetectionCards({hits:[{item:full,extraction:cards.parsedToExtraction(full)}],sourceText:'完整来源',app:'Demo',popup:false})
  assert.equal(built.length,0)
  const detection = detections.listDetections().find(d => d.title===full.title)
  assert.deepEqual(detection.item,full)
  db.close()
  db = globalThis.demoDb = new Database(file)
  const restored = detections.getDetection(detection.id)
  assert.deepEqual(restored.item,full)
  const fullAdded = cards.acceptDetection(detection.id)
  const fullTask = tasks.getTask(fullAdded.taskId)
  for (const [taskKey,itemKey] of Object.entries({startTime:'start_time',dueTime:'due_time',location:'location',notes:'notes',tags:'tags',priority:'priority',itemType:'item_type',evidence:'evidence'}))
    assert.deepEqual(fullTask[taskKey],full[itemKey],taskKey)
  assert.equal(fullTask.belongsToUser,'yes')
  const legacyAccepted = cards.acceptDetection('legacy')
  assert.equal(tasks.getTask(legacyAccepted.taskId).title,'旧行日程')
  assert.equal(tasks.getTask(legacyAccepted.taskId).belongsToUser,'yes')
  console.log('✓ 完整候选经SQLite关闭/重开后接受保留全部字段；旧行摘要兼容且迁移幂等')

  const expired = detections.addDetection({title:'过期详情',timeIso:null,deadline:false,sourceText:'敏感临时原文',item:mk('过期详情'),hits:[],app:'Demo'}).detection
  db.prepare('UPDATE detections SET created_at=? WHERE id=?').run(localIso(Date.now()-49*3600000),expired.id)
  detections.cleanupStaleDetections()
  assert.equal(detections.getDetection(expired.id).sourceText,'')
  assert.equal(detections.getDetection(expired.id).item,null)
  assert.equal(detections.getDetection(expired.id).title,'过期详情')
  assert.ok(detections.getDetection(detection.id).item, '48h内的证据保留')
  assert.deepEqual(tasks.getTask(fullAdded.taskId).notes,full.notes,'清理临时证据不改已确认任务')
  console.log('✓ 48h同时清除JSON和原文，不延长留存，不重写已确认任务')
} finally {
  if (db?.open) db.close()
  delete globalThis.demoDb
  delete globalThis.demoOutput
  delete globalThis.demoPreviews
  rmSync(temp,{recursive:true,force:true})
}
