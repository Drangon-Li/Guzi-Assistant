import { readdirSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const screenwatch = readFileSync(new URL('../src/main/screenwatch.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/main/history/service.ts', import.meta.url), 'utf8')
// IPC 注册按领域拆在 src/main/ipc/ 下：入口与各领域文件拼起来断言
const ipc = [new URL('../src/main/ipc.ts', import.meta.url), ...readdirSync(new URL('../src/main/ipc/', import.meta.url))
  .filter((f) => f.endsWith('.ts')).map((f) => new URL(`../src/main/ipc/${f}`, import.meta.url))]
  .map((url) => readFileSync(url, 'utf8')).join('\n')
const reset = readFileSync(new URL('../src/main/data-reset.ts', import.meta.url), 'utf8')
const channels = readFileSync(new URL('../src/shared/ipc-channels.ts', import.meta.url), 'utf8')
let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed += 1
}

check('History pause is a dedicated runtime state', /let historyPaused = false/.test(service) && /export async function pauseHistory/.test(service))
const pauseStart = service.indexOf('export async function pauseHistory')
const resumeStart = service.indexOf('export async function resumeHistory')
const pauseBlock = service.slice(pauseStart, resumeStart)
check('pause does not route through the legacy global watcher pause', pauseBlock.includes('stopHistoryPersistence') && !pauseBlock.includes('setWatchPaused'))
check('collector callback resolves the current singleton after resume', /if \(isExitPreparing\(\) \|\| historyPaused \|\| historyMutationPending > 0/.test(service) && /historyStore\?\.append\(decision\.suppressed/.test(service))
check('store replacement waits for the close tail', /startAfter: historyCloseTail/.test(service))
check('IPC exposes all eight History operations', ['history:status', 'history:recent', 'history:search', 'history:summarize', 'history:pause', 'history:resume', 'history:clear', 'history:delete-range'].every((name) => ipc.includes(`'${name}'`)))
check('all History IPC operations are preload-whitelisted', ['history:status', 'history:recent', 'history:search', 'history:summarize', 'history:pause', 'history:resume', 'history:clear', 'history:delete-range'].every((name) => channels.includes(`'${name}'`)))
// 取某个 handler 的源码：从它的注册处到下一个注册处（不依赖 handler 在文件里的相邻顺序）
const handlerBlock = (channel) => {
  const start = ipc.indexOf(`ipcMain.handle('${channel}'`)
  const next = ipc.indexOf('ipcMain.handle(', start + 1)
  return start < 0 ? '' : ipc.slice(start, next < 0 ? undefined : next)
}
const dataWipeBlock = handlerBlock('data:wipe')
const memoryWipeBlock = handlerBlock('memory:wipe')
check('data wipe delegates to the coordinator that clears History before SQLite VACUUM',
  dataWipeBlock.includes('await resetAllUserContent()') && reset.includes('acquireHistoryMutationBarrier()') &&
    reset.includes('await clearHistory()') && reset.indexOf('await clearHistory()') < reset.indexOf('wipeAll()'))
check('legacy memory wipe clears History before SQLite VACUUM',
  memoryWipeBlock.includes("async ()") && memoryWipeBlock.includes('acquireHistoryMutationBarrier()') &&
    memoryWipeBlock.includes('await clearHistory()') && memoryWipeBlock.indexOf('await clearHistory()') < memoryWipeBlock.indexOf('wipeMemory()'))
check('History deletion raises a barrier and invalidates active summaries',
  /let historyMutationPending = 0/.test(service) &&
    /historySummarizer\?\.invalidateAndWait\(\)/.test(service) &&
    /historyMutationPending > 0/.test(service))
check('manual summaries re-check lifecycle state after store startup',
  /runHistorySummaryAfterStoreStart\(/.test(service) &&
    /historyMutationEpoch === startEpoch/.test(service) &&
    /historyMutationEpoch !== startEpoch/.test(service) &&
    /historyPaused/.test(service) &&
    /historyStore === store/.test(service))
check('History v2 can run the native collector without the OCR watcher',
  /function startSampler\(\)[\s\S]*configureHistoryCollector\(\)/.test(screenwatch) &&
    /stopWatch\(\)\s*\n\s*if \(historyV2Enabled\) startSampler\(\)/.test(screenwatch))
check('automatic summary completion refreshes History',
  /function notifyAutomaticHistorySummary\(result: SummaryRunResult\)/.test(service) &&
    /notifyAutomaticHistorySummary\(result\)/.test(service) &&
    /broadcast\('guzi-assistant:history-updated'\)/.test(service))
check('automatic summary refresh only considers actual changes',
  /result\.tenMinuteChanged <= 0/.test(service) &&
    /result\.sixHourChanged <= 0/.test(service) &&
    /result\.summariesPruned <= 0/.test(service))

assert.equal(failed, 0, `${failed} runtime checks failed`)
console.log('\nHistory runtime checks passed')
