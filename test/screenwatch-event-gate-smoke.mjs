import { readdirSync, readFileSync } from 'node:fs'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const screenwatch = readFileSync(new URL('../src/main/screenwatch.ts', import.meta.url), 'utf8')
const sampler = readFileSync(new URL('../src/main/usage-sampler.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/main/history/service.ts', import.meta.url), 'utf8')
const privacy = readFileSync(new URL('../src/main/privacy.ts', import.meta.url), 'utf8')
const parser = readFileSync(new URL('../src/main/parser.ts', import.meta.url), 'utf8')
const capture = readFileSync(new URL('../src/main/capture.ts', import.meta.url), 'utf8')
// 数据层按领域拆到 src/main/db/ 下，这里把整个目录拼起来断言，避免钉死在某个文件上。
const db = readdirSync(new URL('../src/main/db/', import.meta.url))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(new URL(`../src/main/db/${f}`, import.meta.url), 'utf8'))
  .join('\n')
const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')

const watchStart = screenwatch.indexOf('async function watchTick')
const contextGate = screenwatch.indexOf('const snapshot = await getScreenSnapshot(signal)', watchStart)
const screenshot = screenwatch.indexOf('png = await captureScreenSilently(snapshot, signal)', watchStart)

check('自动扫描先读取上下文再截图', contextGate > watchStart && contextGate < screenshot)
check('上下文失败时 fail-closed', /snapshotSafetyReason\(snapshot\)[\s\S]*if \(safetyReason \|\| !snapshot\)[\s\S]*自动采集 fail-closed[\s\S]*return/.test(screenwatch))
check('事件门控与 Hybrid 矩阵共同控制截图', /activityScanDecision[\s\S]*gateEligible[\s\S]*if \(!gateEligible\)/.test(screenwatch) && /decideOcrTrigger/.test(screenwatch))
check('每次 OCR 记录明确触发原因', /markOcrFallback\(triggerReason\)/.test(screenwatch) && /recordOcrEvidence/.test(screenwatch))
const cancelAborts = /cancelInFlight\(\): void \{[\s\S]*?this\.abort\?\.abort\(\)[\s\S]*?this\.scans\.cancel\(\)/.test(screenwatch)
check('停止监控会 abort 在途任务', cancelAborts && /export function stopWatch\(\)[^{]*\{\s*loop\.cancelInFlight\(\)/.test(screenwatch))
check('暂停监控会 abort 在途任务', cancelAborts && /export function setWatchPaused[\s\S]*?if \(paused\) \{\s*loop\.cancelInFlight\(\)/.test(screenwatch))
const timeline = readFileSync(new URL('../src/shared/activity-timeline.ts', import.meta.url), 'utf8')
check('应用时长 60 秒无输入后停止', /IDLE_SKIP_SEC = ACTIVITY_IDLE_SECONDS/.test(sampler) && /ACTIVITY_IDLE_SECONDS = 60/.test(timeline) && /idleSeconds >= IDLE_SKIP_SEC/.test(sampler))
check('锁屏/睡眠不补记应用时长', /powerMonitor\.on\('suspend', onSuspend\)/.test(sampler) && /powerMonitor\.on\('lock-screen', onLock\)/.test(sampler) && /epoch !== generation \|\| suspended \|\| locked/.test(sampler) && /state: suspended \? 'suspended' : locked \? 'locked'/.test(sampler))
check('模型调用接收外部 AbortSignal', /externalSignal\?: AbortSignal/.test(parser))
check('屏幕解析透传 AbortSignal', /parseToItemsRaw\([\s\S]*signal/.test(screenwatch))
check('截图留存默认关闭', /screenSenseKeepShots: map\.screenSenseKeepShots === 'true'/.test(db))
check('OCR 观察内容声明为不可信', /不可信 OCR 数据/.test(capture))
check('视觉观察内容声明为不可信', /不可信观察截图/.test(capture))
check('诊断日志不写 OCR 原文', !/OCR 原文---|text\.slice\(0, 4000\)/.test(screenwatch))
check('检测 OCR 原文有 48h 清理', /UPDATE detections SET source_text=''[\s\S]*48 \* 60 \* 60/.test(db))
check('新增 additive 片段和 OCR 证据表', /CREATE TABLE IF NOT EXISTS activity_segments/.test(db) && /CREATE TABLE IF NOT EXISTS ocr_evidence/.test(db))
check('historyV2Enabled 保存后即时重启监控', /activityPolicyChanged = \['historyV2Enabled'/.test(ipc) && /activityPolicyChanged \|\|[\s\S]*applyScreenSenseSettings\(\)/.test(ipc))
check('History 设置包含独立 host include/exclude', /historyIncludedHosts: parseList\(map\.historyIncludedHosts\)/.test(db) && /historyExcludedHosts: parseList\(map\.historyExcludedHosts\)/.test(db))
check('History 关闭时不把 History host/app 过滤带入旧屏幕感知', /const historyEnabled = getSettings\(\)\.historyV2Enabled/.test(screenwatch) && /privacyForContext\(context, historyEnabled\)/.test(screenwatch) && /historyOnly = false/.test(privacy))
check('暂停/停止会排队关闭 History store', /stopSampler[\s\S]*stopHistoryPersistence/.test(screenwatch))
check('History replacement waits for previous lock release', /startAfter: historyCloseTail/.test(service))
check('工作记录只由时间线派生，屏幕识别不再顺带写工作记录', !/maybeAddWorkRecord|work_summary|wantWorkLog/.test(screenwatch) && /deriveTimelineWorkRecords/.test(service) && !/historyDerivedWorkEnabled/.test(service))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
