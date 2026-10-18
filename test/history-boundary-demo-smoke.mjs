import assert from 'node:assert/strict'
import { decideHistoryPrivacy } from '../src/main/history/privacy-policy.ts'
import { HistorySummarizer, summarizeTenMinuteSegment } from '../src/main/history/summarizer.ts'
import { deriveTimelineWorkRecords } from '../src/main/history/work-derivation.ts'

const START = Date.parse('2026-10-18T10:00:00.000Z')
const NOW = START + 20 * 60_000
const at = (offset) => new Date(START + offset).toISOString()
const event = (id, offset, extra = {}) => ({
  id, occurred_at:at(offset), kind:'click', source:'collector', app_name:'Code',
  bundle_id:'com.microsoft.VSCode', window_title:'公开项目代码', url_host:null,
  target_role:'button', target_label:`编辑步骤 ${id}`, command:'pointer_action',
  modifiers:[], input_length:null, secure_input:false, privacy_state:'normal', suppressed:false,
  ...extra
})
const snapshot = (events) => ({
  metadata:{
    id:'history-10m-2026-10-18T10:00:00.000Z', bucketStart:at(0), bucketEnd:at(600_000),
    eventsPath:'unused/demo.jsonl', eventCount:events.length, meaningfulEventCount:events.length,
    suppressedEventCount:0, summaryStatus:'pending', summaryText:null, summaryJson:null,
    retentionExpiresAt:at(48*3600_000+600_000), createdAt:at(0), updatedAt:at(590_000)
  },
  events
})
function memoryHarness(snapshots) {
  const rows = new Map()
  const writes = []
  const patches = []
  return {
    rows, writes, patches,
    summaryIndex:{
      upsert(row) { rows.set(row.id,structuredClone(row)); writes.push(structuredClone(row)) },
      get(id) { return rows.get(id) ?? null },
      remove(id) { rows.delete(id) },
      list(level) { return [...rows.values()].filter(row => !level || row.level===level) },
      count(level) { return this.list(level).length }
    },
    store:{
      async listSegmentSnapshots() { return structuredClone(snapshots) },
      async updateSummary(id,patch) {
        patches.push({id,...patch})
        const current = snapshots.find(item=>item.metadata.id===id)
        if (current) Object.assign(current.metadata,{summaryStatus:patch.status,summaryText:patch.text,summaryJson:patch.json})
        return true
      }
    }
  }
}
const allowedBy = (policy) => (stored) => decideHistoryPrivacy({
  appName:stored.app_name, bundleId:stored.bundle_id, windowTitle:stored.window_title,
  urlHost:stored.url_host, ...policy
}).persist
const supplement = (label) => JSON.stringify({summary:label,focus_task:'开发公开项目',focus:'编辑代码',progress:'完成修改',confidence:0.85})

{
  assert.equal(decideHistoryPrivacy({appName:'Password App',bundleId:'demo.password',excludedApps:['Password App']}).persist,false)
  assert.equal(decideHistoryPrivacy({appName:'Ordinary App',bundleId:'demo.blocked',excludedBundleIds:['demo.blocked']}).persist,false)
  assert.equal(decideHistoryPrivacy({appName:'Chrome',bundleId:'com.google.Chrome',urlHost:'private.example.com',excludedHosts:['example.com']}).persist,false)
  const unknown = decideHistoryPrivacy({appName:'Chrome',bundleId:'com.google.Chrome',urlHost:null,excludedHosts:['example.com']})
  assert.equal(unknown.persist,false)
  assert.equal(unknown.reason,'unknown_browser_host')
  assert.equal(decideHistoryPrivacy({appName:'Chrome',bundleId:'com.google.Chrome',includedHosts:['public.example.com']}).persist,false)
  assert.equal(decideHistoryPrivacy({appName:'Code',bundleId:'com.microsoft.VSCode',urlHost:null,excludedHosts:['example.com']}).persist,true)
  assert.equal(decideHistoryPrivacy({appName:'Chrome',bundleId:'com.google.Chrome',urlHost:'public.example.org',excludedHosts:['example.com']}).persist,true)
  console.log('✓ History隐私策略拒绝应用/站点黑名单和host未知浏览器，非浏览器无host正常')
}

{
  const h = memoryHarness([snapshot([
    event('public',60_000,{target_label:'允许保留的公开修改'}),
    event('newly-excluded-app',120_000,{app_name:'PrivateApp',window_title:'排除应用独有机密标记',target_label:'排除应用独有机密标记'}),
    event('newly-excluded-host',180_000,{app_name:'Chrome',bundle_id:'com.google.Chrome',url_host:'private.example.com',window_title:'排除站点独有机密标记',target_label:'排除站点独有机密标记'}),
    event('unknown-browser',240_000,{app_name:'Chrome',bundle_id:'com.google.Chrome',window_title:'未知站点独有标记',target_label:'未知站点独有标记'})
  ])])
  // The events were already persisted before the user changed these settings.
  const policy = {excludedApps:['PrivateApp'],excludedHosts:['example.com']}
  const calls = []
  const callbacks = []
  const summarizer = new HistorySummarizer({
    ...h, now:()=>NOW, onlineEnabled:()=>true,
    eventAllowed:allowedBy(policy), policyKey:()=>JSON.stringify(policy),
    modelCall:async (instructions,input)=>{ calls.push({instructions,input}); return supplement('仅总结公开修改') },
    onTenMinuteSummary:(document)=>callbacks.push(document)
  })
  try {
    const result = await summarizer.process(NOW)
    assert.equal(calls.length,1)
    const request = JSON.stringify(calls)
    assert.ok(request.includes('允许保留的公开修改'))
    for (const excluded of ['PrivateApp','排除应用独有机密标记','private.example.com','排除站点独有机密标记','未知站点独有标记'])
      assert.ok(!request.includes(excluded),`model request leaked ${excluded}`)
    assert.equal(result.modelSuccesses,1)
    assert.equal(callbacks.length,1)
    assert.equal(callbacks[0].evidenceCount,1)
    assert.deepEqual(callbacks[0].apps,['Code'])
    console.log('✓ 已存事件按最新设置过滤，排除应用/站点/未知浏览器信息不会进入模型请求或派生回调')
  } finally { await summarizer.close() }
}

{
  const h = memoryHarness([snapshot([event('in-flight',60_000)])])
  let policy = 'policy-before'
  let startCall
  let finishCall
  const modelStarted = new Promise(resolve=>{startCall=resolve})
  const modelResponse = new Promise(resolve=>{finishCall=resolve})
  const callbacks = []
  const summarizer = new HistorySummarizer({
    ...h, now:()=>NOW, onlineEnabled:()=>true, policyKey:()=>policy,
    modelCall:async ()=>{startCall(); return modelResponse},
    onTenMinuteSummary:(document)=>callbacks.push(document)
  })
  try {
    const processing = summarizer.process(NOW)
    await modelStarted
    const writesBefore = h.writes.length
    const patchesBefore = h.patches.length
    policy = 'policy-after'
    finishCall(supplement('过时飞行结果不得保存'))
    const result = await processing
    assert.equal(result.modelSuccesses,0)
    assert.equal(h.writes.length,writesBefore)
    assert.equal(h.patches.length,patchesBefore)
    assert.equal(callbacks.length,0)
    assert.ok(!JSON.stringify([...h.rows.values()]).includes('过时飞行结果不得保存'))
    console.log('✓ 模型飞行中policyKey变化，过时结果不写摘要、segment metadata或工作回调')
  } finally { await summarizer.close() }
}

{
  const events = Array.from({length:65},(_,i)=>event(`busy-${i}`,20_000+i*8500,{
    target_label:i===0?'开始撰写报告':i===64?'报告提交成功，任务已完成':`撰写报告第${i}步`
  }))
  const {document} = summarizeTenMinuteSegment(snapshot([...events].reverse()))
  assert.equal(document.observedData.length,24)
  assert.equal(document.observedData[0].label,'开始撰写报告')
  assert.ok(document.observedData.at(-1).label.includes('报告提交成功'))
  assert.ok(document.observedData.at(-1).label.includes('任务已完成'))
  assert.equal(new Set(document.observedData.map(item=>item.occurredAt)).size,24)
  assert.equal(document.evidenceCount,65)
  console.log('✓ 超过24条事件按时间覆盖头尾，最后的完成/提交证据保留在observedData')
}

{
  const {document,sourceHash} = summarizeTenMinuteSegment(snapshot([
    event('first-evidence',30_000),event('last-evidence',590_000,{target_label:'公开项目修改完成'})
  ]))
  document.focusTask='开发公开项目'
  const interval = (id,start,end,extra={}) => ({
    id,sessionId:'demo-session',startMs:START+start,endMs:START+end,state:'active',
    appName:'Code',bundleId:'com.microsoft.VSCode',historyAllowed:true,endReason:'heartbeat',...extra
  })
  const intervals = [
    interval('left-clipped',-60_000,60_000),
    interval('idle',60_000,480_000,{state:'idle'}),
    // 480000..510000 is a collector gap with no observed interval.
    interval('right-clipped',510_000,660_000),
    interval('unknown',100_000,110_000,{state:'unknown'}),
    interval('privacy-disabled',120_000,130_000,{historyAllowed:false}),
    interval('other-app',140_000,150_000,{appName:'Chrome'}),
    interval('missing-app',160_000,170_000,{appName:null}),
    interval('outside-bucket',700_000,710_000)
  ]
  const rows = deriveTimelineWorkRecords(document,sourceHash,intervals)
  assert.equal(rows.length,2)
  assert.deepEqual(rows.map(row=>row.intervalId),['left-clipped','right-clipped'])
  assert.deepEqual(rows.map(row=>[row.startAt,row.endAt,row.activeMs]),[
    [at(0),at(60_000),60_000],[at(510_000),at(600_000),90_000]
  ])
  assert.equal(rows.reduce((sum,row)=>sum+row.activeMs,0),150_000)
  assert.ok(rows.reduce((sum,row)=>sum+row.activeMs,0)<Date.parse(document.endAt)-Date.parse(document.startAt))
  assert.deepEqual(deriveTimelineWorkRecords(document,sourceHash,intervals),rows)
  assert.equal(new Set(rows.map(row=>JSON.stringify([row.segmentId,row.intervalId]))).size,2)
  assert.deepEqual(deriveTimelineWorkRecords(document,sourceHash,intervals.map(row=>({...row,historyAllowed:false}))),[])
  console.log('✓ 10m摘要与真实active区间求交裁剪，仅计150秒；idle/gap/unknown/隐私排除不计，重复派生键稳定')
}


{
  const raw = Array.from({length:55},(_,i)=>event(`raw-${i}`,10_000+i*10_000,{
    target_label:i===0?'原始活动开头':`公开代码编辑${i}`
  }))
  const h = memoryHarness([snapshot(raw)])
  let extras = [
    event('ocr-allowed',590_000,{kind:'screen_changed',source:'fallback',target_label:'允许OCR报告已提交（敏感值***）'}),
    event('ocr-excluded-app',595_000,{kind:'screen_changed',source:'fallback',app_name:'PrivateApp',target_label:'排除OCR应用独有标记'}),
    event('ocr-excluded-host',596_000,{kind:'screen_changed',source:'fallback',app_name:'Chrome',bundle_id:'com.google.Chrome',url_host:'secret.example.com',target_label:'排除OCR站点独有标记'})
  ]
  const ranges = []
  const requests = []
  const derivedBatches = []
  const durableWork = new Map()
  const active = [{id:'ocr-active-interval',sessionId:'ocr-demo',startMs:START+20_000,endMs:START+50_000,
    state:'active',appName:'Code',bundleId:'com.microsoft.VSCode',historyAllowed:true,endReason:'heartbeat'}]
  const summarizer = new HistorySummarizer({
    ...h,now:()=>NOW,onlineEnabled:()=>true,
    eventAllowed:allowedBy({excludedApps:['PrivateApp'],excludedHosts:['example.com']}),
    policyKey:()=> 'ocr-demo-policy',
    supplementalEvents:(from,to)=>{ranges.push([from,to]);return structuredClone(extras)},
    modelCall:async (_instructions,input)=>{requests.push(input);return supplement('公开代码与允许OCR摘要')},
    onTenMinuteSummary:(document,hash)=>{
      const rows=deriveTimelineWorkRecords(document,hash,active)
      derivedBatches.push(rows)
      for(const row of rows) durableWork.set(JSON.stringify([row.segmentId,row.intervalId]),row)
    }
  })
  try {
    await summarizer.process(NOW)
    assert.deepEqual(ranges[0],[START,START+600_000])
    assert.equal(requests.length,1)
    const modelRequest=JSON.stringify(requests[0])
    assert.ok(modelRequest.includes('允许OCR报告已提交'))
    assert.ok(!modelRequest.includes('排除OCR应用独有标记'))
    assert.ok(!modelRequest.includes('排除OCR站点独有标记'))
    assert.ok(!modelRequest.includes('secret.example.com'))
    const [firstRecord]=h.summaryIndex.list('10m')
    const firstDocument=JSON.parse(firstRecord.summaryJson)
    assert.equal(firstDocument.evidenceCount,56)
    assert.equal(firstDocument.observedData.length,24)
    assert.equal(firstDocument.observedData[0].label,'原始活动开头')
    assert.ok(firstDocument.observedData.at(-1).label.includes('允许OCR报告已提交'))
    assert.equal([...durableWork.values()].reduce((sum,row)=>sum+row.activeMs,0),30_000)
    const writesBeforeReplay=h.writes.length
    const replay=await summarizer.process(NOW)
    assert.equal(requests.length,1,'相同OCR重放不再次调用模型')
    assert.equal(replay.tenMinuteChanged,0)
    assert.equal(h.writes.length,writesBeforeReplay)
    assert.equal(durableWork.size,1)
    assert.deepEqual(derivedBatches[1],derivedBatches[0],'相同OCR重放产生相同工作记录输入')
    assert.equal([...durableWork.values()].reduce((sum,row)=>sum+row.activeMs,0),30_000,'OCR重放不累加工时')
    extras=extras.map(item=>item.id==='ocr-allowed'?{...item,target_label:'允许OCR更新：复核报告完成'}:item)
    await summarizer.process(NOW)
    assert.equal(requests.length,2,'允许OCR证据变化必须重新生成模型摘要')
    assert.notEqual(h.summaryIndex.get(firstRecord.id).sourceHash,firstRecord.sourceHash,'sourceHash包含补充OCR证据')
    assert.equal(durableWork.size,1)
    assert.equal([...durableWork.values()].reduce((sum,row)=>sum+row.activeMs,0),30_000)
    const allowedHash=h.summaryIndex.get(firstRecord.id).sourceHash
    extras=extras.map(item=>item.id==='ocr-excluded-app'?{...item,target_label:'排除OCR变更仍不应触发模型'}:item)
    await summarizer.process(NOW)
    assert.equal(requests.length,2,'被排除OCR变化不影响有效摘要')
    assert.equal(h.summaryIndex.get(firstRecord.id).sourceHash,allowedHash)
    console.log('✓ 同bucket允许OCR进入模型并保留尾部完成证据；排除OCR过滤，重复重放不再次调用模型或累加工时，更新OCR改变sourceHash')
  } finally { await summarizer.close() }
}
