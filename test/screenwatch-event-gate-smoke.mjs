import { readFileSync } from 'node:fs'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const screenwatch = readFileSync(new URL('../src/main/screenwatch.ts', import.meta.url), 'utf8')
const parser = readFileSync(new URL('../src/main/parser.ts', import.meta.url), 'utf8')
const capture = readFileSync(new URL('../src/main/capture.ts', import.meta.url), 'utf8')
const db = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')

const watchStart = screenwatch.indexOf('async function watchTick')
const contextGate = screenwatch.indexOf('const context = await getFrontmostContext()', watchStart)
const screenshot = screenwatch.indexOf('png = await captureScreenSilently()', watchStart)

check('自动扫描先读取上下文再截图', contextGate > watchStart && contextGate < screenshot)
check('上下文失败时 fail-closed', /if \(!context\?\.name\)[\s\S]*自动采集 fail-closed[\s\S]*return/.test(screenwatch))
check('事件门控与 Hybrid 矩阵共同控制截图', /activityScanDecision[\s\S]*gateEligible[\s\S]*if \(!gateEligible\)/.test(screenwatch) && /decideOcrTrigger/.test(screenwatch))
check('每次 OCR 记录明确触发原因', /markOcrFallback\(triggerReason\)/.test(screenwatch) && /recordOcrEvidence/.test(screenwatch))
check('停止监控会 abort 在途任务', /export function stopWatch[\s\S]*watchAbort\?\.abort\(\)/.test(screenwatch))
check('暂停监控会 abort 在途任务', /export function setWatchPaused[\s\S]*watchAbort\?\.abort\(\)/.test(screenwatch))
check('应用时长 60 秒无输入后停止', /const IDLE_SKIP_SEC = 60/.test(screenwatch))
check('锁屏/睡眠不补记应用时长', /powerMonitor\.on\('suspend', markSystemInactive\)/.test(screenwatch) && /powerMonitor\.on\('lock-screen', markSystemInactive\)/.test(screenwatch) && /systemInactive/.test(screenwatch))
check('模型调用接收外部 AbortSignal', /externalSignal\?: AbortSignal/.test(parser))
check('屏幕解析透传 AbortSignal', /parseToItemsRaw\([\s\S]*signal/.test(screenwatch))
check('截图留存默认关闭', /screenSenseKeepShots: map\.screenSenseKeepShots === 'true'/.test(db))
check('OCR 观察内容声明为不可信', /不可信 OCR 数据/.test(capture))
check('视觉观察内容声明为不可信', /不可信观察截图/.test(capture))
check('诊断日志不写 OCR 原文', !/OCR 原文---|text\.slice\(0, 4000\)/.test(screenwatch))
check('检测 OCR 原文有 48h 清理', /UPDATE detections SET source_text=''[\s\S]*48 \* 60 \* 60/.test(db))
check('新增 additive 片段和 OCR 证据表', /CREATE TABLE IF NOT EXISTS activity_segments/.test(db) && /CREATE TABLE IF NOT EXISTS ocr_evidence/.test(db))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
