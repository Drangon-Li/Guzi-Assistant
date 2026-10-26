const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const { root } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'))
const config = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'))
const directory = path.join(root, 'cases', config.name)
for (const name of ['userData', 'sessionData', 'cache', 'crashDumps']) {
  const target = path.join(directory, name)
  fs.mkdirSync(target, { recursive: true })
  app.setPath(name, target)
}
app.setPath('logs', path.join(directory, 'logs'))
const logFile = path.join(directory, 'events.jsonl')
const record = (event, detail = {}) => fs.appendFileSync(logFile, `${JSON.stringify({ time: Date.now(), pid: process.pid, event, detail })}\n`)
let bridge, window, timer, allowQuit = false, installApproved = false, performedAction = false, downloaded = false, lastPhase
const status = () => JSON.parse(bridge.status())
app.on('before-quit', (event) => {
  clearInterval(timer)
  record('before-quit', { installApproved, allowQuit, status: bridge ? status() : null })
  if (!bridge || installApproved || allowQuit || !status().sessionInProgress) return
  event.preventDefault()
  bridge.cancel()
  const waiting = setInterval(() => {
    if (status().sessionInProgress) return
    clearInterval(waiting)
    record('quit-released', status())
    allowQuit = true
    app.quit()
  }, 10)
})
app.on('will-quit', () => record('will-quit'))
process.on('uncaughtException', (error) => { record('fixture-error', { message: error.stack }); app.exit(1) })
process.on('unhandledRejection', (error) => { record('fixture-error', { message: String(error) }); app.exit(1) })

app.whenReady().then(() => {
  const dataFile = path.join(app.getPath('userData'), 'preserved.json')
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify({ marker: config.name }))
  record('launched', {
    version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'),
    data: JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  })
  window = new BrowserWindow({ width: 620, height: 260, show: true })
  window.loadURL(`data:text/html,<h2>Sparkle isolated Electron test</h2><p>${config.name} / ${app.getVersion()}</p><pre id="state">Starting</pre>`)
  if (app.getVersion() === '2.0.0') {
    record('updated-relaunched')
    setTimeout(() => app.quit(), 200)
    return
  }
  bridge = require('./sparkle-bridge.node')
  for (const method of ['start', 'check', 'download', 'install', 'cancel', 'status']) assert.equal(typeof bridge[method], 'function')
  assert.throws(() => bridge.status('unexpected'), /no arguments/)
  assert.equal(bridge.download(), false)
  assert.equal(bridge.install(), false)
  assert.equal(bridge.start(), true, bridge.status())
  assert.equal(bridge.start(), true)
  assert.equal(bridge.check(), true)
  if (config.mode === 'check-cancel') { performedAction = true; bridge.cancel(); record('cancel-check') }
  timer = setInterval(() => {
    const snapshot = status()
    if (snapshot.phase !== lastPhase) {
      lastPhase = snapshot.phase
      record('status', snapshot)
      if (!window.isDestroyed()) window.webContents.executeJavaScript(`document.getElementById('state').textContent=${JSON.stringify(JSON.stringify(snapshot, null, 2))}`).catch(() => {})
    }
    if (snapshot.phase === 'available' && !downloaded && !performedAction) {
      if (config.mode === 'available-cancel') {
        performedAction = true
        bridge.cancel()
        record('cancel-available')
      } else {
        downloaded = true
        assert.equal(bridge.download(), true)
        record('download-requested')
      }
    }
    if (!performedAction && config.mode === 'download-cancel' && snapshot.phase === 'downloading' && snapshot.receivedBytes > 0) {
      performedAction = true
      bridge.cancel()
      record('cancel-download', snapshot)
    }
    if (!performedAction && ['verify-cancel', 'verify-quit'].includes(config.mode) && snapshot.phase === 'verifying') {
      performedAction = true
      record(config.mode, snapshot)
      if (config.mode === 'verify-quit') app.quit()
      else bridge.cancel()
    }
    if (!performedAction && snapshot.phase === 'ready') {
      performedAction = true
      record('ready', snapshot)
      if (config.mode === 'install') {
        installApproved = true
        assert.equal(bridge.install(), true)
      } else if (config.mode === 'ordinary-quit') app.quit()
      else {
        record(config.mode === 'save-cancel' ? 'save-gate-cancelled' : 'cancel-ready')
        bridge.cancel()
        assert.equal(bridge.install(), false)
      }
    }
    if (!snapshot.sessionInProgress && ['cancelled', 'error', 'latest'].includes(snapshot.phase)) {
      clearInterval(timer)
      record('terminal', snapshot)
      setTimeout(() => app.quit(), 200)
    }
  }, 10)
})
