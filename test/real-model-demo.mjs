import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { posix, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// Deliberately outside *-smoke.mjs: npm test must never make these paid requests.
// Offline: node test/real-model-demo.mjs
// Live: node test/real-model-demo.mjs --run --config /private/tmp/guzi-model.json --out /private/tmp/guzi-result.json [--ocr | --vision]
// Offline review: node test/real-model-demo.mjs --review-report /private/tmp/guzi-result.json --out /private/tmp/guzi-reviewed.json
const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const live = args.includes('--run')
const vision = args.includes('--vision')
const ocr = vision || args.includes('--ocr')
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null
const timeoutMs = Number(option('--timeout-ms') ?? 90_000)
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120_000, 'timeout must be 1000..120000ms')
for (const arg of args.filter((value) => value.startsWith('--'))) {
  assert.ok(['--run', '--ocr', '--vision', '--validate-only', '--config', '--out', '--timeout-ms', '--review-report'].includes(arg), `unknown option ${arg}`)
}
assert.ok(!(live && args.includes('--validate-only')), '--run and --validate-only are mutually exclusive')
function positiveClaim(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].find((match) =>
    !/(?:不代表|不等于|不证明|不能|无法|未能|尚未|尚无|没有)[^，,。！？;；\n]{0,20}$/.test(text.slice(Math.max(0, match.index - 24), match.index)))
}
function editingCompletionCheck(documents) {
  const claims = documents.flatMap((document) => ['summary', 'progress', 'outcome'].flatMap((field) => {
    const text = document[field] ?? ''
    const match = positiveClaim(text, /(?:已(?:经)?完成|完成了)[^。！？;；\n]{0,40}(?:编辑|开发|修复|修改|调试)|(?:编辑|开发|修复|修改|调试)[^。！？;；\n]{0,24}(?:已(?:经)?完成|完成了)/)
    return match ? [{ documentId: document.id, field, claim: match[0], text }] : []
  }))
  return { check: '不把编辑动作推断为完成', pass: claims.length === 0, claims }
}
const narrativeText = (document) => ['summary', 'progress', 'outcome'].map((field) => document?.[field] ?? '').join('\n')
function historyClaimChecks(documents) {
  const withoutResults = documents.slice(0, 2)
  const resultDocument = documents[2]
  const resultText = narrativeText(resultDocument)
  const checkList = [
    editingCompletionCheck(documents),
    { check: '前两段无结果时不捏造测试通过', pass: withoutResults.every((d) => !positiveClaim(narrativeText(d), /测试(?:全部)?(?:已)?通过|全部(?:测试)?通过|12\s*passed|已修复所有/i)) }
  ]
  if (resultDocument) checkList.push(
    { check: '第三段如实引用明确测试通过结果', pass: /12\s*(?:passed|(?:项|个|条)?(?:测试)?(?:全部)?通过)/i.test(resultText) },
    { check: '第三段不升级为所有开发或修复完成', pass: !positiveClaim(resultText, /(?:全部|所有|整个|整体|项目)[^。！？;；\n]{0,30}(?:开发|修复)[^。！？;；\n]{0,20}(?:完成|结束|成功)|(?:开发|修复)[^。！？;；\n]{0,20}(?:全部|所有|整体|整个)[^。！？;；\n]{0,12}(?:完成|结束|成功)/) }
  )
  return checkList
}
if (option('--review-report')) {
  assert.ok(!live && !option('--config'), 'report review is offline and must not receive model credentials')
  const input = option('--review-report')
  const output = option('--out')
  assert.ok(output && resolve(input) !== resolve(output), 'review requires a distinct --out file; original report is preserved')
  const reviewed = JSON.parse(readFileSync(input, 'utf8'))
  for (const item of reviewed.cases) {
    if (item.case !== 'History区间和稳定标签' || !Array.isArray(item.actual?.documents)) continue
    const addedChecks = historyClaimChecks(item.actual.documents)
    item.review = { originalPass: item.pass, addedChecks, qualityIssue: addedChecks.some((check) => !check.pass) }
    item.checks = [...item.checks.filter((entry) => !addedChecks.some((check) => check.check === entry.check)), ...addedChecks]
    item.pass = item.checks.every((entry) => entry.pass)
  }
  reviewed.review = { mode: 'offline-report-review', sourceReport: resolve(input), reviewedAt: new Date().toISOString(), additionalModelRequests: 0 }
  reviewed.summary = { passed: reviewed.cases.filter((c) => c.pass === true).length, failed: reviewed.cases.filter((c) => c.pass === false).length, skipped: reviewed.cases.filter((c) => c.pass == null).length }
  writeFileSync(output, `${JSON.stringify(reviewed, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ output, summary: reviewed.summary, review: reviewed.review, qualityIssues: reviewed.cases.filter((c) => c.review?.qualityIssue).map((c) => ({ case: c.case, ...c.review })) }, null, 2)}\n`)
  process.exit(reviewed.summary.failed ? 1 : 0)
}
const temp = mkdtempSync(join(tmpdir(), 'guzi-real-model-demo-'))
const stateKey = '__guziRealModelDemo'
const originalFetch = globalThis.fetch
const execFileAsync = promisify(execFile)
const report = {
  mode: live ? 'real-model' : 'offline-structure-validation',
  syntheticOnly: true,
  capturedDesktop: false,
  startedAt: new Date().toISOString(),
  cases: []
}
let settings = { apiBase: '', apiKey: '', model: 'offline-placeholder', modelVision: '', modelChat: '', apiFormat: 'auto', useCustomModel: true }

function selectedDeclarations(name, requested) {
  const source = readFileSync(join(root, name), 'utf8')
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
  const selected = file.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return requested.includes(node.name?.text)
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some((d) => requested.includes(d.name.getText(file)))
    return false
  })
  assert.equal(selected.length, requested.length, `production declarations changed in ${name}`)
  return selected.map((node) => node.getText(file)).join('\n')
}

const stubs = {
  'src/main/db.ts': `const d=globalThis.${stateKey};
    export const getSettings=()=>d.settings;
    export const getProfile=()=>({name:'林小谷',nicknames:['小谷'],accounts:['lin-demo'],identity:'worker',org:'合成演示公司',group:'产品研发组',confirmMode:'standard',workHours:'09:00-18:00',belongingNotMine:[]});
    export const listTasks=()=>[];
    export const listTaskTags=()=>[];
    export const personalMemoryText=()=>'';`,
  'src/main/session.ts': `export const getSession=()=>({functionsBase:'',token:null});`,
  'electron': `export const app={getPath:()=>globalThis.${stateKey}.temp};`,
  'src/main/capture.ts': selectedDeclarations('src/main/capture.ts', ['LIST_EXTRACTION_RULES', 'SCREEN_LIST_EXTRACTION_RULES', 'SCREEN_NOT_SCHEDULE_RULES', 'HINTS']),
  'src/main/work-records.ts': `import { ACTIVITY_SUMMARY_RULES } from '../shared/semantic-work.ts';\n${selectedDeclarations('src/main/work-records.ts', ['workSummaryHint'])}`,
  'src/main/detection-cards.ts': selectedDeclarations('src/main/detection-cards.ts', ['parsedToExtraction'])
}
const compiled = new Set()
const dest = (name) => join(temp, name === 'electron' ? 'electron.mjs' : name.replace(/\.ts$/, '.mjs'))
function compile(name) {
  if (compiled.has(name)) return
  compiled.add(name)
  assert.ok(name in stubs || name.startsWith('src/shared/') || name.startsWith('src/main/history/') || ['src/main/parser.ts', 'src/main/model-client.ts', 'src/main/ocr.ts'].includes(name), `unexpected production dependency ${name}`)
  let code = ts.transpileModule(stubs[name] ?? readFileSync(join(root, name), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true
  })
  assert.equal(code.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0, `cannot transpile ${name}`)
  code = code.outputText.replace(/((?:from\s*|import\s*\(\s*)['"])([^'"]+)(['"])/g, (whole, before, spec, after) => {
    if (spec !== 'electron' && !spec.startsWith('.') && !spec.startsWith('@shared/')) return whole
    let target = spec === 'electron' ? 'electron' : spec.startsWith('@shared/') ? `src/shared/${spec.slice(8)}` : posix.resolve('/', posix.dirname(name), spec).slice(1)
    if (target !== 'electron' && !target.endsWith('.ts')) target += '.ts'
    compile(target)
    return before + pathToFileURL(dest(target)).href + after
  })
  mkdirSync(dirname(dest(name)), { recursive: true })
  writeFileSync(dest(name), code)
}
const load = async (name) => { compile(name); return import(pathToFileURL(dest(name)).href) }
function checks(values) { return Object.entries(values).map(([check, pass]) => ({ check, pass: Boolean(pass) })) }
function safeError(error) {
  let message = error instanceof Error ? error.message : String(error)
  if (settings.apiKey) message = message.replaceAll(settings.apiKey, '[REDACTED]')
  if (settings.apiBase) message = message.replaceAll(settings.apiBase, '[ENDPOINT]')
  return { message: message.slice(0, 500), status: error?.status ?? null, retryAfterMs: error?.retryAfterMs ?? null }
}
let halted = false
async function runCase(name, expected, model, execute) {
  if (halted) {
    report.cases.push({ case: name, expected, actual: null, pass: null, skipped: '前一请求被限流或鉴权拒绝；本批停止，不更换密钥', elapsedMs: 0, model })
    return
  }
  const started = performance.now()
  try {
    const result = await execute()
    report.cases.push({ case: name, expected, ...result, pass: result.checks.every((c) => c.pass), elapsedMs: Math.round(performance.now() - started), model })
  } catch (error) {
    const detail = safeError(error)
    report.cases.push({ case: name, expected, actual: null, error: detail, pass: false, elapsedMs: Math.round(performance.now() - started), model })
    if ([401, 403, 429].includes(detail.status)) halted = true
  }
  process.stderr.write(`${name}: ${report.cases.at(-1).pass ? 'PASS' : 'FAIL'}\n`)
}

try {
  if (live) {
    const configPath = option('--config')
    assert.ok(configPath, '--run requires --config with a minimal existing-model JSON configuration')
    const stat = statSync(configPath)
    assert.ok((stat.mode & 0o077) === 0, 'config must not be readable by group or others (chmod 600)')
    let config
    try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch { throw new Error('cannot read a valid minimal model JSON configuration') }
    assert.ok(config && typeof config === 'object' && !Array.isArray(config), 'config must be an object')
    const allowed = ['apiBase', 'apiKey', 'model', 'modelVision', 'modelChat', 'apiFormat', 'useCustomModel']
    assert.ok(Object.keys(config).every((key) => allowed.includes(key)), 'config contains unrelated fields; provide only model connection fields')
    settings = { ...settings, ...config, useCustomModel: true }
    for (const key of ['apiBase', 'apiKey', 'model']) assert.ok(typeof settings[key] === 'string' && settings[key].trim(), `missing model field: ${key}`)
    for (const key of ['modelVision', 'modelChat', 'apiFormat']) assert.equal(typeof settings[key], 'string', `invalid model field: ${key}`)
  } else {
    assert.ok(!option('--config'), 'offline validation does not read credentials; omit --config')
    globalThis.fetch = async () => { throw new Error('offline validation forbids network') }
  }
  globalThis[stateKey] = { settings, temp }
  const parser = await load('src/main/parser.ts')
  const parsing = await load('src/shared/parsing.ts')
  const { HINTS } = await load('src/main/capture.ts')
  const { workSummaryHint } = await load('src/main/work-records.ts')
  const { parsedToExtraction } = await load('src/main/detection-cards.ts')
  const { detectionQueueDecision } = await load('src/shared/detection-gate.ts')
  const { HistorySummarizer, summarizeTenMinuteSegment } = await load('src/main/history/summarizer.ts')
  const { modelForAction } = await load('src/shared/model-configuration.ts')
  await load('src/main/ocr.ts')
  const queue = (items) => items.filter((item) => detectionQueueDecision(item, parsedToExtraction(item).strong) === 'queue')
  const screenHint = `${HINTS.screen_scan}\n${workSummaryHint('', ['开发演示助手'])}`
  const today = parsing.localNow().slice(0, 10)
  const dueDate = new Date()
  dueDate.setDate(dueDate.getDate() + 2)
  const pad = (n) => String(n).padStart(2, '0')
  const dueDay = `${dueDate.getFullYear()}-${pad(dueDate.getMonth() + 1)}-${pad(dueDate.getDate())}`
  const deadline = `${dueDay}T23:59`
  const textCases = [
    { name: '同一截止日期的不同任务', expected: { count: 2, dueTime: deadline, titlesContain: ['需求', '预算'] },
      text: `合成演示项目群。今天 ${today}，负责人发给林小谷：请你在 ${dueDay} 前分别完成：1. 提交需求说明；2. 提交预算明细。两项都由林小谷负责。`,
      verify: ({ items }) => checks({ '两条本人候选': queue(items).length === 2 && queue(items).every((i) => i.belongs_to_user === 'yes'), '不同标题': new Set(queue(items).map((i) => i.title)).size === 2, '需求与预算均保留': ['需求', '预算'].every((word) => queue(items).some((i) => i.title.includes(word))), '相同截止正确': queue(items).length === 2 && queue(items).every((i) => i.due_time === deadline && !i.start_time) }) },
    { name: '他人分工与模糊归属', expected: { othersMustNotBelongToUser: true, ambiguousMustNotAutoAdd: true },
      text: `合成演示项目群，今天 ${today}。负责人：陈明，请你在 ${dueDay} 前提交法务清单，这一项由陈明独立负责，林小谷不用参与。另有全员通知：请大家在 ${dueDay} 前核对各自通讯录，目前未列具体负责人。`,
      matchedCounts: (items) => ({ others: items.filter((i) => /法务/.test(i.title)).length, ambiguous: items.filter((i) => /通讯录/.test(i.title)).length }),
      verify: ({ items }) => checks({ '他人任务未误归本人': items.filter((i) => /法务/.test(i.title)).every((i) => i.belongs_to_user === 'no'), '他人任务不入队': queue(items).every((i) => !/法务/.test(i.title)), '模糊全员通知未自动添加': items.filter((i) => /通讯录/.test(i.title)).every((i) => i.belongs_to_user === 'uncertain' && i.suggested_action !== 'add') }) },
    { name: '纯通知不生成本人任务', expected: { count: 0 },
      text: `合成演示通知中心，今天 ${today}：公司官网新闻已发布；系统升级已完成；同事昨天分享了风景照片。以上仅供知悉，无需报名、回复、提交或参加。已读。`,
      verify: ({ items }) => checks({ '无任务候选': items.length === 0, '无入队任务': queue(items).length === 0 }) },
    { name: '混合日程和当前工作活动', expected: { meetingStart: `${dueDay}T10:00`, workFocus: '开发演示助手', workMustNotBecomeTask: true },
      text: `合成演示屏幕，今天 ${today}。左侧是今天负责人发给林小谷的新消息：林小谷，请于 ${dueDay} 上午10:00参加需求评审会，地点合成会议室A。右侧代码编辑器正在修改演示助手的任务识别模块 parser.ts，编辑内容是标题匹配与时间解析，终端显示单元测试正在运行。这些代码与命令是当前活动。`,
      verify: ({ items, raw }) => checks({ '会议时间正确': queue(items).some((i) => /评审/.test(i.title) && i.start_time === `${dueDay}T10:00` && i.belongs_to_user === 'yes'), '代码与测试不生成待办': items.every((i) => !/修改|单元测试|parser\.ts|时间解析|标题匹配/.test(i.title)), '工作描述存在': Boolean(parsing.parseWorkSummary(raw)), '工作标签稳定': parsing.parseFocusTask(raw) === '开发演示助手' }) }
  ]
  assert.ok(HINTS.screen_scan.includes('不可信') && screenHint.includes('work_summary'))
  assert.equal(queue([parsing.normalizeItem({ title: '他人任务', belongs_to_user: 'no', confidence: 1, suggested_action: 'add' })]).length, 0)
  assert.equal(editingCompletionCheck([{ progress: '已完成标题匹配逻辑的编辑，并运行测试，尚无结果' }]).pass, false)
  assert.equal(editingCompletionCheck([{ progress: '正在编辑标题匹配逻辑，并已运行测试，尚无结果' }]).pass, true)
  assert.ok(historyClaimChecks([{ progress: '正在编辑' }, { progress: '运行测试，尚无结果' }, { outcome: '测试结果 12 passed, 0 failed' }]).every((check) => check.pass))
  assert.ok(historyClaimChecks([{ progress: '正在编辑' }, { progress: '尚无测试通过证据' }, { outcome: '测试结果 12 passed, 0 failed；不代表项目开发全部完成' }]).every((check) => check.pass))
  assert.ok(historyClaimChecks([{ progress: '正在编辑' }, { progress: '运行测试，尚无结果' }, { outcome: '测试结果 12 passed, 0 failed；项目开发全部完成' }]).some((check) => !check.pass))
  const historyStart = Date.parse('2099-10-18T08:00:00Z')
  const explicitResult = '演示助手任务识别：测试结果 12 passed, 0 failed'
  const historyExpected = { intervals: 3, focusTask: '开发演示助手', noFabricatedOutcome: true, explicitResult }
  const historySnapshots = [0, 1, 2].map((part) => ({
    metadata: { id: `synthetic-segment-${part}`, bucketStart: new Date(historyStart + part * 600_000).toISOString(), bucketEnd: new Date(historyStart + (part + 1) * 600_000).toISOString(), suppressedEventCount: 0 },
    events: [0, 1, 2].map((i) => ({ id: `synthetic-${part}-${i}`, occurred_at: new Date(historyStart + part * 600_000 + i * 180_000).toISOString(),
      kind: part === 2 ? 'screen_changed' : i === 2 ? 'shortcut' : 'click', source: part === 2 ? 'fallback' : 'collector',
      app_name: 'Code', bundle_id: 'com.microsoft.VSCode', window_title: part === 2 ? explicitResult : part ? '演示助手任务识别模块 parser.ts — 继续调试时间解析' : '演示助手任务识别模块 — 编辑标题匹配逻辑',
      url_host: null, target_role: 'AXTextArea', target_label: part === 2 ? explicitResult : i === 2 ? '运行任务识别单元测试（尚无结果）' : '编辑演示助手任务识别模块',
      command: part === 2 ? null : i === 2 ? 'run_test' : 'pointer_action', modifiers: [], input_length: null, secure_input: false, privacy_state: 'normal', suppressed: false }))
  }))
  for (const snapshot of historySnapshots) {
    const { document } = summarizeTenMinuteSegment(snapshot)
    assert.equal(document.evidenceCount, 3)
    assert.equal(document.timeRange.startAt, snapshot.events[0].occurred_at)
    assert.equal(document.timeRange.endAt, snapshot.events.at(-1).occurred_at)
  }
  report.productionModules = [...compiled].filter((name) => !(name in stubs))
  report.promptSources = ['src/main/capture.ts:HINTS', 'src/main/work-records.ts:workSummaryHint', 'src/shared/parsing.ts:buildInstructions', 'src/main/history/summary-prompt.ts']
  if (!live) {
    report.cases = textCases.map(({ name, expected }) => ({ case: name, expected, actual: null, pass: null, status: 'fixture-and-production-imports-validated; model not called' }))
    report.cases.push({ case: 'History区间和稳定标签', expected: historyExpected, actual: null, pass: null, status: 'production-summarizer-import-validated; model not called' })
    report.cases.push({ case: '合成PNG→Apple Vision OCR→文本模型', expected: { syntheticOnly: true, count: 2 }, actual: null, pass: null, status: 'explicit --run --ocr or --vision required' })
    report.cases.push({ case: '合成PNG→图片直读模型', expected: { syntheticOnly: true, count: 2 }, actual: null, pass: null, status: 'explicit --run --vision required' })
    report.validated = true
  } else {
    const model = modelForAction('parse_text', settings)
    for (const fixture of textCases) await runCase(fixture.name, fixture.expected, model, async () => {
      const result = await parser.parseToItemsRaw({ text: fixture.text, hint: screenHint, signal: AbortSignal.timeout(timeoutMs) })
      return { actual: { input: fixture.text, items: result.items, matchedCounts: fixture.matchedCounts?.(result.items), queuedItems: queue(result.items), workSummary: parsing.parseWorkSummary(result.raw), focusTask: parsing.parseFocusTask(result.raw), raw: result.raw }, checks: fixture.verify(result) }
    })
    await runCase('History区间和稳定标签', historyExpected, model, async () => {
      const start = historyStart
      const snapshots = historySnapshots
      const rows = new Map()
      const rawCalls = []
      let failure
      const summaryIndex = { get: (id) => rows.get(id) ?? null, upsert: (row) => rows.set(row.id, row), remove: (id) => rows.delete(id), list: (level) => [...rows.values()].filter((row) => !level || row.level === level) }
      const worker = new HistorySummarizer({ store: { listSegmentSnapshots: async () => snapshots, updateSummary: async () => {} }, summaryIndex, now: () => start + 35 * 60_000, focusTaskCandidates: () => ['开发演示助手'], modelCall: async (instructions, input, signal) => {
        if (failure) throw failure
        try {
          const raw = await parser.callModel(instructions, input, 'parse_text', AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]))
          rawCalls.push({ instructions, input, raw })
          return raw
        } catch (error) { failure = error; throw error }
      } })
      let result
      try { result = await worker.process() } finally { await worker.close() }
      if (failure) throw failure
      const documents = [...rows.values()].map((row) => JSON.parse(row.summaryJson))
      const rawDocuments = rawCalls.map((call, index) => ({ id: snapshots[index].metadata.id, ...parsing.extractJson(call.raw) }))
      const rawChecks = historyClaimChecks(rawDocuments)
      return { actual: { result, documents, modelCalls: rawCalls, rawAudit: { checks: rawChecks, violations: rawChecks.filter((check) => !check.pass), affectsFinalPass: false }, finalAudit: { checks: historyClaimChecks(documents) }, resultEvidence: documents.map((d) => ({ documentId: d.id, evidence: d.resultEvidence ?? [] })) }, checks: [...checks({ '三个10分钟模型摘要成功': result.modelSuccesses === 3 && result.modelFailures === 0, '区间来源准确': documents.length === 3 && documents.every((d, i) => d.bucketStart === snapshots[i].metadata.bucketStart && d.bucketEnd === snapshots[i].metadata.bucketEnd && d.timeRange.startAt === snapshots[i].events[0].occurred_at && d.timeRange.endAt === snapshots[i].events.at(-1).occurred_at), '稳定标签复用': documents.length === 3 && documents.every((d) => d.focusTask === '开发演示助手'), '结果证据引用范围准确': documents.length === 3 && documents.slice(0, 2).every((d) => !d.resultEvidence?.length) && documents[2].resultEvidence?.some((value) => value.normalize('NFKC') === explicitResult.normalize('NFKC')) }), ...historyClaimChecks(documents)] }
    })
    let syntheticPng = null
    if (ocr) await runCase('合成PNG→Apple Vision OCR→文本模型', { count: 2, dueTime: deadline, desktopCaptured: false }, model, async () => {
      assert.equal(process.platform, 'darwin', 'Apple Vision demo requires macOS')
      const png = join(temp, 'synthetic-only.png')
      const swift = join(temp, 'render-synthetic.swift')
      const lines = ['合成演示 — 不是真实聊天/屏幕', `今天 ${today} · 项目负责人`, '林小谷，以下两项均由你负责：', `1. 提交需求说明，截止 ${dueDay} 23:59`, `2. 提交预算明细，截止 ${dueDay} 23:59`, '请分别完成两项。']
      writeFileSync(swift, `import AppKit\nlet lines = ${JSON.stringify(lines)}\nlet image = NSImage(size:NSSize(width:1500,height:760))\nimage.lockFocus()\nNSColor.white.setFill()\nNSRect(x:0,y:0,width:1500,height:760).fill()\nfor (i,line) in lines.enumerated() { (line as NSString).draw(at:NSPoint(x:60,y:660-i*95),withAttributes:[.font:NSFont.systemFont(ofSize:34),.foregroundColor:NSColor.black]) }\nimage.unlockFocus()\nlet bitmap = NSBitmapImageRep(data:image.tiffRepresentation!)!\ntry bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))\n`)
      await execFileAsync('/usr/bin/swift', ['-module-cache-path', join(temp, 'swift-cache'), swift, png], { timeout: 60_000 })
      syntheticPng = png
      const { ocrImageDetailed } = await load('src/main/ocr.ts')
      const boxes = await ocrImageDetailed(png, AbortSignal.timeout(timeoutMs))
      const ocrText = boxes.map((box) => box.text).join('\n')
      const textResult = await parser.parseToItemsRaw({ text: ocrText, hint: HINTS.screen_scan, signal: AbortSignal.timeout(timeoutMs) })
      return { actual: { syntheticLines: lines, ocrText, boxes, items: textResult.items, raw: textResult.raw, imageSizeBytes: statSync(png).size }, checks: checks({ 'OCR读取两个任务': /需求/.test(ocrText) && /预算/.test(ocrText), 'OCR解析保留两项': queue(textResult.items).length === 2, 'OCR截止日期正确': queue(textResult.items).length === 2 && queue(textResult.items).every((i) => i.due_time === deadline) }) }
    })
    if (vision) await runCase('合成PNG→图片直读模型', { count: 2, dueTime: deadline, desktopCaptured: false }, modelForAction('parse_vision', settings), async () => {
      assert.ok(syntheticPng, 'synthetic image was not generated; no desktop image will be substituted')
      const result = await parser.parseToItemsRaw({ imageDataUrl: `data:image/png;base64,${readFileSync(syntheticPng).toString('base64')}`, hint: HINTS.screen_scan_confirm, signal: AbortSignal.timeout(timeoutMs) })
      return { actual: { items: result.items, raw: result.raw, imageSizeBytes: statSync(syntheticPng).size }, checks: checks({ '视觉确认保留两项': queue(result.items).length === 2, '视觉截止日期正确': queue(result.items).length === 2 && queue(result.items).every((i) => i.due_time === deadline) }) }
    })
  }
} catch (error) {
  report.fatal = safeError(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  report.summary = { passed: report.cases.filter((c) => c.pass === true).length, failed: report.cases.filter((c) => c.pass === false).length, skipped: report.cases.filter((c) => c.pass == null).length }
  let serialized = JSON.stringify(report, null, 2)
  if (settings.apiKey) serialized = serialized.replaceAll(settings.apiKey, '[REDACTED]')
  const output = option('--out')
  if (output) writeFileSync(output, `${serialized}\n`, { mode: 0o600 })
  process.stdout.write(`${serialized}\n`)
  if (report.summary.failed) process.exitCode = 1
  globalThis.fetch = originalFetch
  delete globalThis[stateKey]
  rmSync(temp, { recursive: true, force: true })
}
