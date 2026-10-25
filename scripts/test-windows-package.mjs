import assert from 'node:assert/strict'
import { fork, spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

if (process.platform !== 'win32') throw new Error('Packaged Windows smoke tests require Windows')
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, process.argv[2] || 'release/win-unpacked')
const exe = join(directory, 'GuziAssistant.exe')
const resources = join(directory, 'resources')
const helper = join(resources, 'native/GuziWindowsHelper.exe')
const workerPath = join(resources, 'app.asar/out/main/windows-ocr-worker.js')
for (const p of [exe, helper, join(resources, 'capture/preload.cjs'), join(resources, 'ocr/ch_PP-OCRv4_rec_infer.onnx'), join(resources, 'windows-runtime/package.json')]) {
  assert(existsSync(p), `Missing package resource: ${p}`)
}
const selfTest = spawnSync(helper, ['--self-test'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
assert.equal(selfTest.status, 0, selfTest.stderr)
const temp = await mkdtemp(join(tmpdir(), 'guzi-win-smoke-'))
const userData = join(temp, 'profile')
const env = { ...process.env, GUZI_ASSISTANT_USER_DATA_DIR: userData }
delete env.ELECTRON_RUN_AS_NODE
let application, browser, worker, applicationClosed, workerClosed, cleanupPromise
let log = ''
function cleanup() {
  return cleanupPromise ??= (async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill()
    if (workerClosed) await Promise.race([workerClosed, delay(5_000)])
    await browser?.disconnect()
    if (application?.pid && application.exitCode === null && application.signalCode === null) {
      // Terminate only the process tree created by this smoke test.
      spawnSync('taskkill.exe', ['/PID', String(application.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await Promise.race([applicationClosed, delay(5_000)])
    }
    await writeFile(join(root, 'release/windows-smoke.log'), log)
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })()
}
const onSignal = (code) => { void cleanup().then(() => process.exit(code), (error) => { console.error(error); process.exit(code) }) }
process.once('SIGINT', () => onSignal(130))
process.once('SIGTERM', () => onSignal(143))
try {
  const probe = join(temp, 'sqlite.cjs')
  await writeFile(probe, `const Database = require(${JSON.stringify(join(resources, 'app.asar/node_modules/better-sqlite3'))}); const db = new Database(':memory:'); db.exec('CREATE TABLE smoke (value TEXT)'); db.prepare('INSERT INTO smoke VALUES (?)').run('Windows SQLite'); if (db.prepare('SELECT value FROM smoke').get().value !== 'Windows SQLite') process.exit(1); db.close(); console.log('SQLITE_OK');`)
  const sqlite = spawnSync(exe, [probe], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000, windowsHide: true })
  assert.equal(sqlite.status, 0, sqlite.stderr || sqlite.stdout)
  assert.match(sqlite.stdout, /SQLITE_OK/)
  console.log('Packaged Electron SQLite passed')
  application = spawn(exe, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  applicationClosed = new Promise((accept) => application.once('close', accept))
  application.stdout.on('data', (data) => { log += data })
  application.stderr.on('data', (data) => { log += data })
  application.on('error', (error) => { log += error.stack })
  let endpoint
  for (let attempt = 0; attempt < 120; attempt++) {
    if (application.exitCode !== null || application.signalCode !== null) throw new Error(`App exited before startup: ${log}`)
    const port = await readFile(join(userData, 'DevToolsActivePort'), 'utf8').catch(() => '')
    const [number, path] = port.trim().split('\n')
    if (number && path) { endpoint = `ws://127.0.0.1:${number}${path}`; break }
    await delay(250)
  }
  assert(endpoint, `No debugging endpoint after startup: ${log}`)
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint })
  console.log('Packaged application started; DevTools connected')
  let page
  for (let attempt = 0; attempt < 80; attempt++) {
    page = (await browser.pages()).find((candidate) => candidate.url().includes('index.html') && new URL(candidate.url()).hash === '#/main')
    if (page) break
    await delay(250)
  }
  assert(page, 'Main renderer was not created')
  await page.waitForFunction(() => window.guziAssistant?.platform === 'win32' && document.getElementById('root')?.childElementCount > 0, { timeout: 20_000 })
  const version = await page.evaluate(() => window.guziAssistant.invoke('app:version'))
  assert.equal(version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version)
  assert.equal(await page.evaluate(async () => (await window.guziAssistant.invoke('settings:get')).clipWatchEnabled), false)
  console.log('Main renderer, preload and settings passed')
  await page.evaluate(async () => {
    await window.guziAssistant.invoke('settings:save', { historyV2Enabled: false })
    await window.guziAssistant.invoke('profile:save', {
      name: 'Package smoke test', nicknames: [], accounts: [], identity: 'student',
      org: '', group: '', workHours: '', confirmMode: 'standard'
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('aside nav', { timeout: 15_000 })
  assert.equal((await page.evaluate(() => window.guziAssistant.invoke('tasks:list'))).length, 0)
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find((button) => button.textContent.trim() === '设置').click())
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('设置'), { timeout: 10_000 })
  console.log('Profile, task database and settings navigation passed; starting offline OCR')
  // A fixed image keeps OCR verification independent of the runner's language packs.
  const image = join(root, 'test/fixtures/windows-ocr.png')
  const result = await new Promise((accept, reject) => {
    worker = fork(workerPath, [image, join(resources, 'ocr'), join(resources, 'windows-runtime/package.json')], {
      execPath: exe, execArgv: [], env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    workerClosed = new Promise((accept) => worker.once('close', accept))
    let response
    const timer = setTimeout(() => { worker.kill(); reject(new Error('Packaged offline OCR timed out')) }, 60_000)
    worker.stderr.on('data', (data) => { log += data })
    worker.on('message', (message) => { response = message; worker.kill() })
    worker.once('error', (error) => { clearTimeout(timer); reject(error) })
    worker.once('close', () => {
      clearTimeout(timer)
      if (response?.result) accept(response.result)
      else reject(new Error(response?.error || 'OCR worker exited without a result'))
    })
  })
  const text = result.texts.map((line) => line.text).join(' ')
  assert.match(text, /12345/)
  assert.match(text, /谷子助手/)
  assert(result.resizedImageWidth > 0 && result.resizedImageHeight > 0)
  console.log(`Windows package verified: native helper, Electron SQLite, renderer, preload, offline Chinese/English OCR (${text})`)
} catch (error) {
  const detail = error?.stack || String(error)
  log += `\nPackage smoke failure: ${detail}\n`
  console.error(detail)
  throw error
} finally {
  await cleanup()
}
