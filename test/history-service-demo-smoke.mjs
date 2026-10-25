import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { posix, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import ts from 'typescript'
import Database from 'better-sqlite3'

// The actual service, privacy gate, JSONL store and OCR repository run against isolated fixtures.
const root=fileURLToPath(new URL('..',import.meta.url))
const temp=mkdtempSync(join(tmpdir(),'guzi-history-service-demo-'))
const production=[
  'src/main/history/service.ts','src/main/privacy.ts','src/main/history/privacy-policy.ts',
  'src/main/history/event-store.ts','src/main/history/event-schema.ts','src/main/history/retention.ts',
  'src/main/history/work-derivation.ts','src/shared/activity-events.ts','src/shared/work-report.ts',
  'src/shared/history.ts','src/shared/app-exclude.ts','src/shared/sensitive.ts',
  'src/main/db-migrations.ts','src/main/db/activity.ts'
]
const stubs={
  'electron':`export const app={getPath:()=>globalThis.historyServiceDemo.temp,getName:()=> 'GuziDemo'};`,
  'src/main/db.ts':`
    const d=globalThis.historyServiceDemo;
    export const getSettings=()=>d.settings;
    export const getHistorySegmentIndex=()=>d.segmentIndex;
    export const getHistorySummaryIndex=()=>d.summaryIndex;
    export const listFocusTaskCandidates=()=>[];
    export const listKnownAppNames=()=>[];
    export const removeHistoryWorkRecord=()=>{};
    export const removeHistoryWorkRecords=()=>[];
    export const upsertHistoryWorkRecord=(r)=>d.work.push(r);
    export const getDb=()=>d.db;
    export const listActivityIntervals=()=>d.intervals;
    export const usesTimelineForDay=()=>false;
    export const removeTimelineWorkRecords=()=>{};
    export const upsertTimelineWorkRecord=(r)=>d.work.push(r);
    export {addOcrEvidence,listOcrEvidence} from './db/activity.ts';`,
  'src/main/db/connection.ts':`export const getDb=()=>globalThis.historyServiceDemo.db;`,
  'src/main/session.ts':`export const getSession=()=>({functionsBase:'',token:null});`,
  'src/main/windows.ts':`export const broadcast=(...args)=>globalThis.historyServiceDemo.broadcasts.push(args);export const debugEvent=()=>{};`,
  'src/main/activity-tracker.ts':`export const configureHistoryHealthProvider=()=>{};export const clearActivityHistoryEvidence=(...args)=>globalThis.historyServiceDemo.clears.push(args);`,
  'src/main/usage-sampler.ts':`export const configureActivityHistoryAllowed=(fn)=>{globalThis.historyServiceDemo.usageAllowed=fn};export const resetUsageTimelineBoundary=(reason)=>globalThis.historyServiceDemo.boundaries.push(reason);`,
  'src/main/db/activity-retention.ts':`
    export const deleteActivityHistoryRange=(from,to)=>{globalThis.historyServiceDemo.deletedRanges.push([from,to]);return []};
    export const clearActivityHistory=()=>{globalThis.historyServiceDemo.unboundedClears++;return []};`,
  'src/main/history/query-service.ts':`export class HistoryQueryService{constructor(o){this.options=o}clear(){return this.options.clear()}deleteRange(o){return this.options.deleteRange(Date.parse(o.from),Date.parse(o.to))}}`,
  'src/main/history/summarizer.ts':`
    const empty=()=>({tenMinuteSummaries:0,sixHourSummaries:0,tenMinuteChanged:0,sixHourChanged:0,summariesPruned:0,modelSuccesses:0,modelFailures:0});
    export class HistorySummarizer{
      constructor(o){this.options=o;globalThis.historyServiceDemo.summarizers.push(this)}
      async process(){return empty()}
      async close(){}
      async invalidateAndWait(){globalThis.historyServiceDemo.invalidations++}
    }
    export const runHistorySummaryAfterStoreStart=async(store,allowed,run)=>{await store.start();return allowed()?run():null};`
}
const paths=new Set([...production,...Object.keys(stubs)])
const destination=(name)=>join(temp,name==='electron'?'electron.mjs':name.replace(/\.ts$/,'.mjs'))
function compile(name,source){
  let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
  code=code.replace(/(from\s*['"])([^'"]+)(['"])/g,(_,before,spec,after)=>{
    if(spec==='electron')return before+pathToFileURL(destination(spec)).href+after
    if(!spec.startsWith('.')&&!spec.startsWith('@shared/'))return before+spec+after
    let target=spec.startsWith('@shared/')?`src/shared/${spec.slice(8)}`:posix.resolve('/',posix.dirname(name),spec).slice(1)
    if(!target.endsWith('.ts'))target+='.ts'
    assert.ok(paths.has(target),`unexpected service dependency: ${name} -> ${spec}`)
    return before+pathToFileURL(destination(target)).href+after
  })
  mkdirSync(dirname(destination(name)),{recursive:true})
  writeFileSync(destination(name),code)
}
const index=()=>{
  const rows=new Map()
  return {upsert:r=>rows.set(r.id,structuredClone(r)),get:id=>rows.get(id)??null,
    remove:id=>rows.delete(id),list:()=>[...rows.values()],count:()=>rows.size}
}
let service
let db
try{
  for(const name of production)compile(name,readFileSync(join(root,name),'utf8'))
  for(const [name,source]of Object.entries(stubs))compile(name,source)
  db=new Database(':memory:')
  const d=globalThis.historyServiceDemo={
    temp,db,settings:{historyV2Enabled:true,historyDerivedWorkEnabled:false,screenSenseWorkLog:false,
      screenSenseExcludedApps:[],historyExcludedApps:[],historyIncludedHosts:[],historyExcludedHosts:[],apiBase:'',apiKey:''},
    segmentIndex:index(),summaryIndex:index(),summarizers:[],intervals:[],work:[],boundaries:[],clears:[],deletedRanges:[],unboundedClears:0,broadcasts:[],invalidations:0
  }
  const load=name=>import(pathToFileURL(destination(name)))
  const {migrateOcrEvidenceContext}=await load('src/main/db-migrations.ts')
  const ocr=await load('src/main/db/activity.ts')
  db.exec(`CREATE TABLE ocr_evidence (
    id TEXT PRIMARY KEY,event_id TEXT,segment_id TEXT,occurred_at TEXT,app_name TEXT,bundle_id TEXT,window_title TEXT,
    semantic_score REAL,trigger_reason TEXT,redaction_hits TEXT,redacted_text TEXT,created_at TEXT)`)
  db.prepare("INSERT INTO ocr_evidence VALUES ('legacy',NULL,NULL,?,'Code','com.microsoft.VSCode','旧窗口',80,'demo','[]','旧脱敏证据',?)")
    .run(new Date().toISOString(),new Date().toISOString())
  migrateOcrEvidenceContext(db)
  migrateOcrEvidenceContext(db)
  const old=ocr.listOcrEvidence().find(row=>row.id==='legacy')
  assert.equal(old.windowId,null)
  assert.equal(old.urlHost,null)
  assert.equal(old.redactedText,'旧脱敏证据')
  assert.equal(db.prepare('SELECT count(*) AS n FROM ocr_evidence').get().n,1)
  console.log('✓ OCR上下文SQLite加列迁移幂等，旧行windowId/urlHost为null且原内容完整')

  service=await load('src/main/history/service.ts')
  assert.equal(d.usageAllowed(),true)
  let store=service.startHistoryPersistence()
  await store.start()
  const now=Date.now()
  const context={name:'Code',bundleId:'com.microsoft.VSCode',windowTitle:'公开项目',urlHost:null}
  const activity=(id,extra={})=>({id,occurredAtMs:now,kind:'click',source:'collector',appName:'Code',bundleId:'com.microsoft.VSCode',windowTitle:`公开活动 ${id}`,targetLabel:'编辑代码',privacyState:'normal',...extra})
  const evidence=(id,extra={})=>({id,eventId:null,segmentId:null,occurredAt:new Date(now).toISOString(),appName:'Code',bundleId:'com.microsoft.VSCode',windowTitle:'公开项目',windowId:7,urlHost:null,semanticScore:85,triggerReason:'demo',redactionHits:[],redactedText:`允许证据 ${id}`,createdAt:new Date(now).toISOString(),...extra})
  const persisted=async()=> (await store.listSegmentSnapshots()).flatMap(item=>item.events)
  const ids=async()=> (await persisted()).map(row=>row.id)
  const countOcr=()=>db.prepare('SELECT count(*) AS n FROM ocr_evidence').get().n
  service.appendHistoryEventIfRunning(activity('allowed-event'))
  service.appendOcrEvidenceIfAllowed(evidence('allowed-ocr'))
  assert.ok((await ids()).includes('allowed-event'))
  assert.equal(ocr.listOcrEvidence().find(row=>row.id==='allowed-ocr').windowId,7)
  const beforeBlockedOcr=countOcr()
  d.settings.screenSenseExcludedApps=['PrivateApp']
  d.settings.historyExcludedApps=[{bundleId:'demo.blocked'}]
  d.settings.historyExcludedHosts=['example.com']
  service.appendHistoryEventIfRunning(activity('excluded-app',{appName:'PrivateApp',windowTitle:'排除应用秘密'}))
  service.appendHistoryEventIfRunning(activity('excluded-bundle',{bundleId:'demo.blocked',windowTitle:'排除Bundle秘密'}))
  service.appendHistoryEventIfRunning(activity('excluded-host',{appName:'Chrome',bundleId:'com.google.Chrome',urlHost:'private.example.com',windowTitle:'排除站点秘密'}))
  service.appendHistoryEventIfRunning(activity('unknown-host',{appName:'Chrome',bundleId:'com.google.Chrome',urlHost:null,windowTitle:'未知站点秘密'}))
  for(const [id,extra]of [['excluded-app',{appName:'PrivateApp'}],['excluded-bundle',{bundleId:'demo.blocked'}],['excluded-host',{appName:'Chrome',bundleId:'com.google.Chrome',urlHost:'private.example.com'}],['unknown-host',{appName:'Chrome',bundleId:'com.google.Chrome'}]])
    service.appendOcrEvidenceIfAllowed(evidence(id,extra))
  const blockedIds=await ids()
  for(const id of ['excluded-app','excluded-bundle','excluded-host','unknown-host'])assert.ok(!blockedIds.includes(id))
  assert.equal(countOcr(),beforeBlockedOcr)
  assert.ok(!JSON.stringify(await persisted()).includes('秘密'))
  service.appendHistoryEventIfRunning(activity('nonbrowser-no-host'))
  service.appendOcrEvidenceIfAllowed(evidence('nonbrowser-no-host-ocr'))
  assert.ok((await ids()).includes('nonbrowser-no-host'))
  assert.equal(countOcr(),beforeBlockedOcr+1)
  service.appendOcrEvidenceIfAllowed(evidence('allowed-host-ocr',{appName:'Chrome',bundleId:'com.google.Chrome',urlHost:'public.example.org',windowId:42}))
  const hostRow=ocr.listOcrEvidence().find(row=>row.id==='allowed-host-ocr')
  assert.equal(hostRow.urlHost,'public.example.org')
  assert.equal(hostRow.windowId,42)
  const runningSummarizer=d.summarizers.at(-1)
  const currentPolicy=runningSummarizer.options.policyKey()
  const beforeSettingChange=(await persisted()).find(row=>row.id==='allowed-event')
  assert.equal(runningSummarizer.options.eventAllowed(beforeSettingChange),true)
  d.settings.historyExcludedApps.push({bundleId:'com.microsoft.VSCode'})
  assert.notEqual(runningSummarizer.options.policyKey(),currentPolicy)
  assert.equal(runningSummarizer.options.eventAllowed(beforeSettingChange),false)
  d.settings.historyExcludedApps.pop()
  console.log('✓ 真正service接线过滤当前app/Bundle/host设置；被排除内容不写JSONL/OCR，非浏览器无host可写')

  const beforePauseEpoch=service.getHistoryContentEpoch()
  assert.equal(service.historyContentAllowed(context,beforePauseEpoch),true)
  const paused=await service.pauseHistory()
  assert.equal(paused.paused,true)
  assert.equal(d.usageAllowed(),false)
  assert.ok(d.boundaries.includes('history_pause'))
  assert.equal(service.historyContentAllowed(context,beforePauseEpoch),false)
  const pausedOcr=countOcr()
  service.appendHistoryEventIfRunning(activity('while-paused'))
  service.appendOcrEvidenceIfAllowed(evidence('while-paused'))
  assert.equal(countOcr(),pausedOcr)
  await service.resumeHistory()
  store=service.startHistoryPersistence()
  await store.start()
  assert.equal(d.usageAllowed(),true)
  assert.ok(d.boundaries.includes('history_resume'))
  assert.ok(!(await ids()).includes('while-paused'))
  service.appendHistoryEventIfRunning(activity('after-resume'))
  assert.ok((await ids()).includes('after-resume'))
  console.log('✓ pause/resume关闭与重建真实store，usage权限及边界随状态更新，暂停期间两路均不落内容')

  const beforeDisableCount=(await ids()).length
  const beforeDisableOcr=countOcr()
  d.settings.historyV2Enabled=false
  service.appendHistoryEventIfRunning(activity('while-disabled'))
  service.appendOcrEvidenceIfAllowed(evidence('while-disabled'))
  assert.equal(d.usageAllowed(),false)
  assert.equal(service.historyContentAllowed(context),false)
  assert.equal((await ids()).length,beforeDisableCount)
  assert.equal(countOcr(),beforeDisableOcr)
  d.settings.historyV2Enabled=true
  const release=service.acquireHistoryMutationBarrier()
  service.appendHistoryEventIfRunning(activity('during-mutation'))
  service.appendOcrEvidenceIfAllowed(evidence('during-mutation'))
  assert.equal(service.historyContentAllowed(context),false)
  release()
  release()
  assert.ok(!(await ids()).includes('during-mutation'))
  assert.equal(countOcr(),beforeDisableOcr)
  assert.equal(service.historyContentAllowed(context),true)
  console.log('✓ 禁用及mutation barrier阻断真实service两路写入，release幂等且恢复允许状态')

  const oldEpoch=service.getHistoryContentEpoch()
  let finishModel
  const fakeModel=new Promise(resolve=>{finishModel=resolve})
  const lateResult=fakeModel.then(result=>{
    if(!service.historyContentAllowed(context,oldEpoch))return false
    service.appendOcrEvidenceIfAllowed(evidence('late-model',{redactedText:result}))
    return true
  })
  service.invalidateHistoryContent()
  assert.ok(d.boundaries.includes('privacy_changed'))
  assert.ok(d.invalidations>0)
  assert.equal(service.historyContentAllowed(context,oldEpoch),false)
  assert.equal(service.historyContentAllowed(context,service.getHistoryContentEpoch()),true)
  finishModel('过时模型结果')
  assert.equal(await lateResult,false)
  assert.equal(countOcr(),beforeDisableOcr)
  const clearStartedAt=Date.now()
  await service.clearHistory()
  const clearEndedAt=Date.now()
  assert.ok(d.boundaries.includes('history_cleared'))
  assert.equal(d.unboundedClears,0,'清空48h历史不得调用全量durable timeline清理')
  assert.equal(d.deletedRanges.length,1)
  const [clearedFrom,clearedTo]=d.deletedRanges[0]
  assert.equal(clearedTo-clearedFrom,48*60*60_000+1)
  assert.ok(clearedTo>=clearStartedAt+1&&clearedTo<=clearEndedAt+1)
  assert.deepEqual(d.clears,[d.deletedRanges[0]],'内存证据清理范围与48h持久化清理一致')
  assert.deepEqual(await ids(),[])
  console.log('✓ privacy epoch变化拒绝晚到模型结果，clearHistory实际清JSONL，仅清48h timeline及对应内存证据、重置usage边界')
}finally{
  if(service)await service.shutdownHistoryStore()
  if(db?.open)db.close()
  delete globalThis.historyServiceDemo
  rmSync(temp,{recursive:true,force:true})
}
