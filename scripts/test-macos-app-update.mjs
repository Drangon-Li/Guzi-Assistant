import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { listPackage } from '@electron/asar'
import { verifyBundle } from './verify-macos-release.mjs'
import { sparkleOutput } from './prepare-sparkle.mjs'

assert(process.platform === 'darwin' && process.arch === 'arm64', 'Full application update tests require macOS arm64')
assert(process.argv.slice(2).every((argument) => argument === '--skip-build'), 'Usage: node scripts/test-macos-app-update.mjs [--skip-build]')
const repository = fileURLToPath(new URL('../', import.meta.url))
const root = await realpath(await mkdtemp('/private/tmp/guzi-update-app-'))
const id = randomUUID().replaceAll('-', '')
const appId = `cn.shilong.gooz.update-test.${id}`
const productName = `GuziAssistantUpdateTest-${id}`
const profile = root
const installedApp = join(root, 'installed', `${productName}.app`)
const executable = join(installedApp, 'Contents/MacOS', productName)
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: repository, stdio: 'inherit', ...options })
const results = []
const children = new Set()
const browsers = new Set()
const inspectors = new Set()
const terminationActions = []
let server, activeCase, cleanupPromise, interrupted = false
console.log(`Full application update artifacts: ${root}`)

function ownedProcesses() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    return match && Number(match[1]) !== process.pid && match[2].startsWith(`${root}/`) ? [{ pid: Number(match[1]), command: match[2] }] : []
  })
}

function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const inspector of inspectors) inspector.close()
    for (const browser of browsers) await browser.disconnect()
    server?.closeAllConnections()
    if (server?.listening) await new Promise((accept) => server.close(accept))
    const actions = terminationActions
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    let remaining = ownedProcesses()
    for (const { pid } of remaining) { try { process.kill(pid, 'SIGTERM'); actions.push({ pid, signal: 'SIGTERM' }) } catch (error) { if (error.code !== 'ESRCH') throw error } }
    for (let attempt = 0; attempt < 30 && remaining.length; attempt++) { await delay(100); remaining = ownedProcesses() }
    for (const { pid } of remaining) { try { process.kill(pid, 'SIGKILL'); actions.push({ pid, signal: 'SIGKILL' }) } catch (error) { if (error.code !== 'ESRCH') throw error } }
    await delay(100)
    remaining = ownedProcesses()
    for (const name of ['private-key', 'wrong-private-key']) await rm(join(root, name), { force: true })
    const evidence = { clean: !remaining.length && !server?.listening, remainingProcesses: remaining, serverClosed: !server?.listening, actions }
    await writeFile(join(root, 'cleanup.json'), JSON.stringify(evidence, null, 2))
    assert(evidence.clean, 'Full application test left processes running')
  })()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { interrupted = true; void cleanup().then(() => process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal])) })

async function waitFor(predicate, message, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Full application update test interrupted')
    const result = await predicate()
    if (result) return result
    await delay(100)
  }
  throw new Error(`${message}; artifacts: ${root}`)
}

async function inspectorConnection(endpoint) {
  const socket = new WebSocket(endpoint)
  await new Promise((accept, reject) => { socket.addEventListener('open', accept, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  const waiting = new Map()
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(String(data))
    const request = waiting.get(response.id)
    if (!request) return
    waiting.delete(response.id)
    clearTimeout(request.timer)
    if (response.error) request.reject(new Error(JSON.stringify(response.error)))
    else request.accept(response.result)
  })
  socket.addEventListener('close', () => {
    for (const request of waiting.values()) { clearTimeout(request.timer); request.reject(new Error('Main process inspector disconnected')) }
    waiting.clear()
  })
  const connection = {
    close: () => socket.close(),
    evaluate: async (expression) => {
      const response = await new Promise((accept, reject) => {
        const request = ++sequence
        const timer = setTimeout(() => { waiting.delete(request); reject(new Error('Main process inspector request timed out')) }, 30_000)
        waiting.set(request, { accept, reject, timer })
        socket.send(JSON.stringify({ id: request, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || JSON.stringify(response.exceptionDetails))
      return response.result?.value
    }
  }
  inspectors.add(connection)
  return connection
}

const sqlString = (value) => `'${value.replaceAll("'", "''")}'`
function query(sql) { return JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', join(profile, 'eshell.db'), sql], { encoding: 'utf8' }) || '[]') }
const readNote = (noteId) => query(`SELECT id,title,content FROM p_notebook_note WHERE id=${sqlString(noteId)}`)[0]
const installedVersion = () => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(installedApp, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
const invoke = (page, channel, ...args) => page.evaluate((channel, args) => window.guziAssistant.invoke(channel, ...args), channel, args)

async function startApplication(name) {
  await rm(join(profile, 'DevToolsActivePort'), { force: true })
  const directory = join(root, 'cases', name)
  await mkdir(directory, { recursive: true })
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir(), HOME: home, CFFIXED_USER_HOME: home, LANG: process.env.LANG || 'en_US.UTF-8' }
  const child = spawn(executable, ['--inspect=127.0.0.1:0', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  const collectOutput = (data) => { output += data; appendFileSync(join(directory, 'stdout.log'), data) }
  child.stdout.on('data', collectOutput)
  child.stderr.on('data', collectOutput)
  child.once('error', (error) => { output += error.stack })
  child.once('close', () => { void writeFile(join(directory, 'stdout.log'), output) })
  const inspectorURL = await waitFor(() => {
    assert(child.exitCode === null && child.signalCode === null, `Application exited during startup: ${output}`)
    return output.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]
  }, 'Main process inspector did not start')
  const inspector = await inspectorConnection(inspectorURL)
  const port = await waitFor(async () => {
    assert(child.exitCode === null && child.signalCode === null, `Application exited during startup: ${output}`)
    const endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]
    if (endpoint) return endpoint
    const content = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
    const [number, path] = content.trim().split('\n')
    return number && path ? `ws://127.0.0.1:${number}${path}` : undefined
  }, 'Renderer debugging endpoint did not start')
  const browser = await puppeteer.connect({ browserWSEndpoint: port })
  browsers.add(browser)
  const page = await waitFor(async () => (await browser.pages()).find((candidate) => candidate.url().includes('index.html') && new URL(candidate.url()).hash === '#/main'), 'Main renderer did not open')
  await page.waitForFunction(() => window.guziAssistant && document.getElementById('root')?.childElementCount > 0, { timeout: 30_000 })
  const native = await inspector.evaluate(`(() => { const r = process.mainModule.require.bind(process.mainModule); globalThis.__updateTest = { electron: r('electron'), dialogs: [], decision: 'save' }; return { executable:process.execPath,profile:__updateTest.electron.app.getPath('userData'),version:__updateTest.electron.app.getVersion() }; })()`)
  assert.equal(native.profile, profile)
  assert.equal(native.executable, executable)
  assert.equal(native.version, '1.0.0')
  await inspector.evaluate(`(() => { const t=globalThis.__updateTest; t.originalDialog=t.electron.dialog.showMessageBox; t.electron.dialog.showMessageBox=async (...args)=>{const o=args.find(x=>x&&Array.isArray(x.buttons))||{};t.dialogs.push({message:o.message,buttons:o.buttons,decision:t.decision});let response=t.decision==='cancel'?o.buttons.length-1:t.decision==='discard'?o.buttons.findIndex(x=>x.includes('放弃')):o.buttons.indexOf('保存');return {response:response<0?0:response,checkboxChecked:false};};return true; })()`)
  await inspector.evaluate(`(() => { const t=globalThis.__updateTest,r=process.mainModule.require.bind(process.mainModule),fs=r('fs'),native=r(r('path').join(process.resourcesPath,'native/sparkle-bridge.node'));t.record=(event,detail)=>fs.appendFileSync(${JSON.stringify(join(directory, 'main-events.jsonl'))},JSON.stringify({time:Date.now(),pid:process.pid,event,detail})+String.fromCharCode(10));for(const name of ['before-quit','will-quit','quit'])t.electron.app.on(name,event=>t.record(name,{prevented:event?.defaultPrevented,...(name==='quit'?{}:{native:JSON.parse(native.status())})}));for(const win of t.electron.BrowserWindow.getAllWindows()){const send=win.webContents.send.bind(win.webContents);win.webContents.send=(channel,...args)=>{if(channel==='guzi-assistant:exit-request')t.record('exit-request',{window:win.id,args});return send(channel,...args)};}const handlers=t.electron.ipcMain._invokeHandlers,respond=handlers.get('app:exit-response');handlers.set('app:exit-response',(...args)=>{t.record('exit-response',args.slice(1));return respond(...args)});return true;})()`)
  const state = await invoke(page, 'app:update-state')
  assert.equal(state.mode, 'sparkle', JSON.stringify(state))
  assert.equal(state.channel, 'test')
  return { name, directory, child, inspector, browser, page, native, output: () => output }
}

async function stopApplication(application) {
  await application.inspector.evaluate(`globalThis.__updateTest.decision='discard';globalThis.__updateTest.electron.app.quit();true`).catch(() => {})
  application.inspector.close()
  inspectors.delete(application.inspector)
  await waitFor(() => application.child.exitCode !== null || application.child.signalCode !== null, 'Application did not finish ordinary shutdown')
  await application.browser.disconnect()
  browsers.delete(application.browser)
  assert.equal(application.child.exitCode, 0)
  assert.equal(application.child.signalCode, null)
  await delay(1_000)
  assert.equal(installedVersion(), '1.0.0', 'Ordinary shutdown installed an update')
  assert(!ownedProcesses().some(({ command }) => command === executable || command.startsWith(`${executable} `)), 'Ordinary shutdown unexpectedly relaunched the application')
  await writeFile(join(application.directory, 'stdout.log'), application.output())
}

async function prepareDownload(application) {
  const checked = await invoke(application.page, 'app:check-update')
  assert.equal(checked.phase, 'available', JSON.stringify(checked))
  assert.equal(checked.version, '2.0.0')
  const downloaded = await invoke(application.page, 'app:download-update')
  assert(['downloading', 'verifying', 'ready'].includes(downloaded.phase), JSON.stringify(downloaded))
  const history = []
  const ready = await waitFor(async () => {
    const state = await invoke(application.page, 'app:update-state')
    if (history.at(-1)?.phase !== state.phase) history.push(state)
    if (state.phase === 'error') return state
    return state.phase === 'ready' ? state : undefined
  }, 'Update did not finish verification', 90_000)
  await writeFile(join(application.directory, 'update-states.json'), JSON.stringify(history, null, 2))
  return ready
}

async function openNotebook(application, name) {
  await invoke(application.page, 'profile:save', { name: 'Update integration fixture', nicknames: [], accounts: [], identity: 'student', org: '', group: '', workHours: '', confirmMode: 'standard' })
  await invoke(application.page, 'settings:save', { theme: 'dark', customTags: ['update-integration-fixture'] })
  await invoke(application.page, 'plugins:enable', 'notebook')
  const title = `Update fixture ${name}`
  const base = `Preserved base content ${name}`
  const { id } = await invoke(application.page, 'plugin:notebook:create', { title, content: base })
  await application.page.reload({ waitUntil: 'domcontentloaded' })
  await application.page.waitForFunction(() => [...document.querySelectorAll('aside nav button')].some((button) => button.textContent.includes('记事本')), { timeout: 20_000 })
  await application.page.evaluate(() => [...document.querySelectorAll('aside nav button')].find((button) => button.textContent.includes('记事本')).click())
  await application.page.waitForFunction((title) => [...document.querySelectorAll('section li span')].some((element) => element.textContent === title), { timeout: 20_000 }, title)
  await application.page.evaluate((title) => [...document.querySelectorAll('section li span')].find((element) => element.textContent === title).closest('li').querySelector('div').click(), title)
  await application.page.waitForSelector('[aria-label="笔记正文"]', { timeout: 15_000 })
  assert.equal(readNote(id).content, base)
  return { id, title, base, draft: `Saved during update ${name}` }
}

async function editAndInstall(application, note) {
  await application.page.evaluate((draft) => {
    const editor = document.querySelector('[aria-label="笔记正文"]')
    editor.focus()
    const paragraph = document.createElement('p')
    paragraph.textContent = draft
    editor.replaceChildren(paragraph)
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft }))
    window.__updateTestInstall = window.guziAssistant.invoke('app:install-update')
  }, note.draft)
}

try {
  await mkdir(join(root, 'installed'), { recursive: true })
  await writeFile(join(profile, '.env'), '')
  if (!process.argv.includes('--skip-build')) run('npm', ['run', 'build'])
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  const seed = join(root, 'private-key')
  await writeFile(seed, keys.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'), { mode: 0o600 })
  const wrong = generateKeyPairSync('ed25519')
  const wrongSeed = join(root, 'wrong-private-key')
  await writeFile(wrongSeed, wrong.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'), { mode: 0o600 })
  let feed = ''
  server = http.createServer((request, response) => {
    if (request.url === '/appcast.xml') { response.writeHead(200, { 'content-type': 'application/xml', 'cache-control': 'no-store' }); response.end(feed); return }
    if (!['/update.zip', '/corrupt.zip'].includes(request.url)) { response.writeHead(404); response.end(); return }
    const stream = createReadStream(join(root, request.url.slice(1)))
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    response.writeHead(200, { 'content-type': 'application/zip' })
    stream.pipe(response)
  })
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const origin = `http://127.0.0.1:${server.address().port}`
  for (const version of ['1.0.0', '2.0.0']) {
    run(process.execPath, [join(repository, 'scripts/build-macos-release.mjs'), '--channel', 'test', '--app-id', appId, '--profile-dir', profile, '--feed-url', `${origin}/appcast.xml`, '--public-key', publicKey, '--version', version, '--output', join(root, version), '--dir', '--skip-build'])
    const bundle = join(root, version, 'mac-arm64', `${productName}.app`)
    await verifyBundle(bundle, { version, channel: 'test', publicKey })
    assert(!listPackage(join(bundle, 'Contents/Resources/app.asar')).some((entry) => /(^|\/)\.env$/.test(entry)), 'Test bundle includes an environment file')
  }
  const oldApp = join(root, '1.0.0/mac-arm64', `${productName}.app`)
  const newApp = join(root, '2.0.0/mac-arm64', `${productName}.app`)
  run('/usr/bin/ditto', [oldApp, installedApp])
  const archive = join(root, 'update.zip')
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', newApp, archive])
  const sign = (key) => execFileSync(join(sparkleOutput, 'bin/sign_update'), ['--ed-key-file', key, '-p', archive], { encoding: 'utf8' }).trim()
  const signature = sign(seed)
  const wrongSignature = sign(wrongSeed)
  const bytes = await readFile(archive)
  bytes[1024] ^= 0xff
  await writeFile(join(root, 'corrupt.zip'), bytes)
  const length = (await stat(archive)).size
  const cases = ['wrong-signature', 'corrupt', 'ordinary-quit', 'save-cancel', 'save-failure', 'discard-install', 'save-success']
  for (const name of cases) {
    activeCase = name
    console.log(`RUN full application ${name}`)
    feed = `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Isolated full application test</title><item><title>2.0.0</title><sparkle:version>2.0.0</sparkle:version><sparkle:shortVersionString>2.0.0</sparkle:shortVersionString><enclosure url="${origin}/${name === 'corrupt' ? 'corrupt.zip' : 'update.zip'}" sparkle:edSignature="${name === 'wrong-signature' ? wrongSignature : signature}" length="${length}" type="application/octet-stream"/></item></channel></rss>`
    const application = await startApplication(name)
    const ready = await prepareDownload(application)
    let note
    if (['wrong-signature', 'corrupt'].includes(name)) {
      assert.equal(ready.phase, 'error')
      assert.equal(installedVersion(), '1.0.0')
      await stopApplication(application)
    } else if (name === 'ordinary-quit') {
      assert.equal(ready.phase, 'ready')
      await stopApplication(application)
      assert.equal(installedVersion(), '1.0.0')
    } else {
      assert.equal(ready.phase, 'ready')
      note = await openNotebook(application, name)
      await application.inspector.evaluate(`globalThis.__updateTest.decision=${JSON.stringify(name === 'save-cancel' ? 'cancel' : name === 'discard-install' ? 'discard' : 'save')};true`)
      if (name === 'save-failure') await application.inspector.evaluate(`(() => { const t=globalThis.__updateTest; const handlers=t.electron.ipcMain._invokeHandlers; if(!(handlers instanceof Map)) throw new Error('Electron IPC handler map unavailable'); t.notebookHandler=handlers.get('plugin:notebook:update'); if(!t.notebookHandler) throw new Error('Notebook update handler unavailable'); handlers.set('plugin:notebook:update',async()=>{throw new Error('INJECTED_UPDATE_SAVE_FAILURE')}); return true; })()`)
      await editAndInstall(application, note)
      if (['save-success', 'discard-install'].includes(name)) {
        application.inspector.close()
        inspectors.delete(application.inspector)
        await waitFor(() => application.child.exitCode !== null, 'Old application did not exit after saving')
        assert.equal(application.child.exitCode, 0)
        const intent = await waitFor(async () => {
          const intent = JSON.parse(await readFile(join(profile, 'update-install.json'), 'utf8').catch(() => '{}'))
          return intent.completed === true ? intent : undefined
        }, 'New application did not complete update startup', 90_000)
        assert.equal(intent.targetVersion, '2.0.0')
        const relaunched = await waitFor(() => ownedProcesses().find(({ pid, command }) => pid !== application.child.pid && (command === executable || command.startsWith(`${executable} `))), 'Updated application did not relaunch from the same path')
        await writeFile(join(application.directory, 'relaunched-before-validation.json'), JSON.stringify({ ...relaunched, intent, version: installedVersion() }, null, 2))
        assert.equal(installedVersion(), '2.0.0')
        assert.equal(readNote(note.id).content, name === 'discard-install' ? note.base : note.draft)
        const settings = query("SELECT key,value FROM settings WHERE key IN ('theme','customTags') ORDER BY key")
        assert(settings.some(({ key, value }) => key === 'theme' && value === 'dark'))
        assert(settings.some(({ key, value }) => key === 'customTags' && value.split(',').includes('update-integration-fixture')))
        await verifyBundle(installedApp, { version: '2.0.0', channel: 'test', publicKey })
        await writeFile(join(application.directory, 'relaunched.json'), JSON.stringify({ ...relaunched, intent, note: readNote(note.id), settings }, null, 2))
        await application.browser.disconnect()
        browsers.delete(application.browser)
        if (name !== cases.at(-1)) {
          for (const { pid } of ownedProcesses()) { try { process.kill(pid, 'SIGTERM'); terminationActions.push({ pid, signal: 'SIGTERM', scope: 'baseline-reset' }) } catch (error) { if (error.code !== 'ESRCH') throw error } }
          for (let attempt = 0; attempt < 30 && ownedProcesses().length; attempt++) await delay(100)
          for (const { pid } of ownedProcesses()) { try { process.kill(pid, 'SIGKILL'); terminationActions.push({ pid, signal: 'SIGKILL', scope: 'baseline-reset' }) } catch (error) { if (error.code !== 'ESRCH') throw error } }
          await waitFor(() => !ownedProcesses().length, 'Test application processes remain before resetting the next baseline', 5_000)
        }
      } else {
        const returned = await application.page.evaluate(() => window.__updateTestInstall)
        assert.equal(returned.phase, name === 'save-cancel' ? 'available' : 'error', JSON.stringify(returned))
        if (name === 'save-failure') assert.match(returned.message, /INJECTED_UPDATE_SAVE_FAILURE/)
        const native = await application.inspector.evaluate(`JSON.parse(process.mainModule.require(process.mainModule.require('path').join(process.resourcesPath,'native/sparkle-bridge.node')).status())`)
        assert.equal(native.sessionInProgress, false)
        assert.equal(native.ready, false)
        assert.equal(application.child.exitCode, null)
        assert.equal(installedVersion(), '1.0.0')
        assert.equal(readNote(note.id).content, note.base)
        assert.equal(await application.page.$eval('[aria-label="笔记正文"]', (editor) => editor.textContent), note.draft)
        await application.page.waitForFunction(() => document.documentElement.getAttribute('aria-busy') !== 'true')
        await application.page.screenshot({ path: join(application.directory, 'content-preserved.png') })
        await writeFile(join(application.directory, 'blocked-install.json'), JSON.stringify({ returned, native, note: readNote(note.id), rendererDraft: note.draft }, null, 2))
        const dialogs = await application.inspector.evaluate(`globalThis.__updateTest.dialogs`)
        assert(dialogs.some((dialog) => dialog.message === '记事本有尚未保存的修改'))
        await writeFile(join(application.directory, 'dialogs.json'), JSON.stringify(dialogs, null, 2))
        if (name === 'save-failure') await application.inspector.evaluate(`globalThis.__updateTest.electron.ipcMain._invokeHandlers.set('plugin:notebook:update',globalThis.__updateTest.notebookHandler);true`)
        await stopApplication(application)
      }
    }
    const result = { name, passed: true, initialPid: application.child.pid, initialExit: application.child.exitCode, version: installedVersion(), profile, installedApp, note }
    results.push(result)
    await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2))
    console.log(`PASS full application ${name}: ${result.version}`)
    if (name === 'discard-install') {
      await rm(installedApp, { recursive: true, force: true })
      run('/usr/bin/ditto', [oldApp, installedApp])
    }
  }
  console.log(`Full application Sparkle integration: ${results.length}/${results.length} passed`)
} finally {
  await cleanup()
  console.log(`Full application update cleanup complete; evidence: ${root}`)
}
