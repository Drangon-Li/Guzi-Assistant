import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const screenwatch = readFileSync(new URL('../src/main/screenwatch.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/main/history/service.ts', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
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
check('collector callback resolves the current singleton after resume', /if \(historyPaused\) return/.test(service) && /historyStore\?\.append\(event\)/.test(service))
check('store replacement waits for the close tail', /startAfter: historyCloseTail/.test(service))
check('IPC exposes all eight History operations', ['history:status', 'history:recent', 'history:search', 'history:summarize', 'history:pause', 'history:resume', 'history:clear', 'history:delete-range'].every((name) => ipc.includes(`'${name}'`)))
check('all History IPC operations are preload-whitelisted', ['history:status', 'history:recent', 'history:search', 'history:summarize', 'history:pause', 'history:resume', 'history:clear', 'history:delete-range'].every((name) => channels.includes(`'${name}'`)))
const dataWipeStart = ipc.indexOf("ipcMain.handle('data:wipe'")
const memoryWipeStart = ipc.indexOf("ipcMain.handle('memory:wipe'")
const dataWipeBlock = ipc.slice(dataWipeStart, memoryWipeStart)
const memoryWipeBlock = ipc.slice(memoryWipeStart, ipc.indexOf("ipcMain.handle('permissions:get'"))
check('legacy data wipe clears History before SQLite VACUUM',
  dataWipeBlock.includes("async ()") && dataWipeBlock.includes('acquireHistoryMutationBarrier()') &&
    dataWipeBlock.includes('await clearHistory()') && dataWipeBlock.indexOf('await clearHistory()') < dataWipeBlock.indexOf('wipeAll()'))
check('legacy memory wipe clears History before SQLite VACUUM',
  memoryWipeBlock.includes("async ()") && memoryWipeBlock.includes('acquireHistoryMutationBarrier()') &&
    memoryWipeBlock.includes('await clearHistory()') && memoryWipeBlock.indexOf('await clearHistory()') < memoryWipeBlock.indexOf('wipeMemory()'))
check('legacy wipes invalidate the in-memory baseline fingerprint cache',
  dataWipeBlock.includes('invalidateActivityHistoryPersistenceCache()') &&
    memoryWipeBlock.includes('invalidateActivityHistoryPersistenceCache()'))
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
check('History v2 can run the native collector without the legacy OCR watcher',
  /function startHistoryCollectorOnly\(\)/.test(screenwatch) &&
    /configureHistoryCollector\(\)/.test(screenwatch) &&
    /if \(historyV2Enabled\) startHistoryCollectorOnly\(\)/.test(screenwatch))
check('History-only keeps the legacy 10-minute baseline synchronized in the background',
  /let historyLegacySyncTimer/.test(service) &&
    /function startLegacyHistorySync\(\)/.test(service) &&
    /getActivityRuntimeStatus\(\{/.test(service) &&
    /historyLegacySyncTimer = setInterval\(syncLegacyHistorySegments, 5_000\)/.test(service) &&
    /if \(historyEnabled\) startLegacyHistorySync\(\)/.test(screenwatch))
check('Legacy sync timer is released with the collector lifecycle',
  /function stopLegacyHistorySync\(\)/.test(service) &&
    /clearInterval\(historyLegacySyncTimer\)/.test(service) &&
    /stopLegacyHistorySync\(\)\s+stopActivityCollector\(\)/.test(screenwatch))
check('automatic summary completion invalidates rollout cache and refreshes History',
  /function notifyAutomaticHistorySummary\(result: SummaryRunResult\)/.test(service) &&
    /notifyAutomaticHistorySummary\(result\)/.test(service) &&
    /invalidateHistoryRolloutComparison\(\)\s+broadcast\('guzi-assistant:history-updated'\)/.test(service))
check('automatic summary refresh only considers actual changes',
  /result\.tenMinuteChanged <= 0/.test(service) &&
    /result\.sixHourChanged <= 0/.test(service) &&
    /result\.summariesPruned <= 0/.test(service))

assert.equal(failed, 0, `${failed} runtime checks failed`)
console.log('\nHistory runtime checks passed')
