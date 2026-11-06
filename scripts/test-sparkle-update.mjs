import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { sparkleOutput, sparkleRelease } from './prepare-sparkle.mjs'

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Sparkle integration tests require macOS arm64')
const repository = fileURLToPath(new URL('../', import.meta.url))
// Since Electron 42 the npm package downloads its binary on first use instead of at install time;
// require('electron') fetches it when missing and returns .../Electron.app/Contents/MacOS/Electron.
const electronApp = join(dirname(createRequire(import.meta.url)('electron')), '../..')
const root = await realpath(await mkdtemp(join(tmpdir(), 'guzi-sparkle-update-')))
const bundleId = `com.guzi.sparkle.test.${randomUUID().replaceAll('-', '')}`
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', ...options })
let activeCase, server, interrupted = false, cleanupPromise
const children = new Set()
const results = []
const cleanupActions = []
const archiveRequests = new Map()
console.log(`Sparkle test artifacts: ${root}`)

function ownedProcesses() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    return match && Number(match[1]) !== process.pid && match[2].includes(root) ? [Number(match[1])] : []
  })
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    server?.closeAllConnections()
    if (server?.listening) await new Promise((accept) => server.close(accept))
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    let remaining = ownedProcesses()
    for (const pid of remaining) { try { process.kill(pid, 'SIGTERM'); cleanupActions.push({ pid, signal: 'SIGTERM' }) } catch (error) { if (error.code !== 'ESRCH') throw error } }
    for (let attempt = 0; attempt < 30 && remaining.length; attempt++) { await delay(100); remaining = ownedProcesses() }
    for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); cleanupActions.push({ pid, signal: 'SIGKILL' }) } catch (error) { if (error.code !== 'ESRCH') throw error } }
    await delay(100)
    remaining = ownedProcesses()
    for (const name of ['private-key', 'wrong-private-key']) await rm(join(root, name), { force: true })
    const evidence = { clean: !remaining.length && !server?.listening, remainingProcesses: remaining, serverClosed: !server?.listening, cleanupActions }
    await writeFile(join(root, 'cleanup.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    assert(evidence.clean, `Sparkle test processes remain: ${remaining.join(', ')}`)
  })()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { interrupted = true; void cleanup().then(() => process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal])) })

async function events(name) {
  const text = await readFile(join(root, 'cases', name, 'events.jsonl'), 'utf8').catch(() => '')
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function buildBundle(version, publicKey, feedURL) {
  const target = join(root, 'versions', version, 'SparkleTest.app')
  await mkdir(dirname(target), { recursive: true })
  run('/usr/bin/ditto', [electronApp, target])
  run('/usr/bin/ditto', [join(sparkleOutput, 'Sparkle.framework'), join(target, 'Contents/Frameworks/Sparkle.framework')])
  const resources = join(target, 'Contents/Resources/app')
  await mkdir(resources, { recursive: true })
  await copyFile(join(sparkleOutput, 'sparkle-bridge.node'), join(resources, 'sparkle-bridge.node'))
  await copyFile(join(repository, 'test/fixtures/sparkle-update/main.cjs'), join(resources, 'main.cjs'))
  await writeFile(join(resources, 'fixture.json'), JSON.stringify({ root }))
  await writeFile(join(resources, 'package.json'), JSON.stringify({ name: 'guzi-sparkle-test', version: `${version}.0.0`, main: 'main.cjs' }))
  const plist = join(target, 'Contents/Info.plist')
  const strings = { CFBundleIdentifier: bundleId, CFBundleName: 'GuziSparkleTest', CFBundleVersion: version, CFBundleShortVersionString: `${version}.0.0`, SUFeedURL: feedURL, SUPublicEDKey: publicKey }
  for (const [key, value] of Object.entries(strings)) run('/usr/bin/plutil', ['-replace', key, '-string', value, plist])
  for (const key of ['SUEnableAutomaticChecks', 'SUAutomaticallyUpdate', 'SUAllowsAutomaticUpdates']) run('/usr/bin/plutil', ['-replace', key, '-bool', 'false', plist])
  run('/usr/bin/plutil', ['-replace', 'SUVerifyUpdateBeforeExtraction', '-bool', 'true', plist])
  run('/usr/bin/plutil', ['-replace', 'NSAppTransportSecurity', '-json', '{"NSAllowsLocalNetworking":true,"NSAllowsArbitraryLoads":true}', plist])
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
  return target
}

try {
  await stat(join(sparkleOutput, 'sparkle-bridge.node')).catch(() => { throw new Error('Run node scripts/prepare-sparkle.mjs before this test') })
  const seedFile = join(root, 'private-key')
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  await writeFile(seedFile, keys.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'), { mode: 0o600 })
  const wrongKey = generateKeyPairSync('ed25519')
  await writeFile(join(root, 'wrong-private-key'), wrongKey.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'), { mode: 0o600 })
  assert.equal((await stat(seedFile)).mode & 0o777, 0o600)
  let feed = ''
  server = http.createServer((request, response) => {
    if (request.url === '/appcast.xml') { response.writeHead(200, { 'content-type': 'application/xml', 'cache-control': 'no-store' }); response.end(feed); return }
    if (!['/update.zip', '/corrupt.zip'].includes(request.url)) { response.writeHead(404); response.end(); return }
    archiveRequests.set(activeCase, (archiveRequests.get(activeCase) || 0) + 1)
    response.writeHead(200, { 'content-type': 'application/zip' })
    const stream = createReadStream(join(root, request.url.slice(1)), { highWaterMark: 256 * 1024 })
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    if (activeCase === 'download-cancel') {
      stream.on('data', (chunk) => { stream.pause(); response.write(chunk); setTimeout(() => { if (!stream.destroyed) stream.resume() }, 15) })
      stream.on('end', () => response.end())
    } else stream.pipe(response)
  })
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const oldApp = await buildBundle('1', publicKey, `${origin}/appcast.xml`)
  const newApp = await buildBundle('2', publicKey, `${origin}/appcast.xml`)
  const archive = join(root, 'update.zip')
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', newApp, archive])
  const sign = (key) => execFileSync(join(sparkleOutput, 'bin/sign_update'), ['--ed-key-file', key, '-p', archive], { encoding: 'utf8' }).trim()
  const signature = sign(seedFile)
  const wrongSignature = sign(join(root, 'wrong-private-key'))
  run(join(sparkleOutput, 'bin/sign_update'), ['--verify', '--ed-key-file', seedFile, archive, signature])
  const bytes = await readFile(archive)
  bytes[1024] ^= 0xff
  await writeFile(join(root, 'corrupt.zip'), bytes)
  const length = (await stat(archive)).size
  const cases = ['install', 'ordinary-quit', 'cancel', 'save-cancel', 'verify-cancel', 'verify-quit', 'available-cancel', 'download-cancel', 'check-cancel', 'wrong-signature', 'corrupt', 'latest']
  for (const name of cases) {
    if (interrupted) throw new Error('Sparkle test interrupted')
    activeCase = name
    const directory = join(root, 'cases', name)
    const target = join(directory, 'installed/SparkleTest.app')
    const home = join(directory, 'home')
    await mkdir(dirname(target), { recursive: true })
    await mkdir(home, { recursive: true })
    run('/usr/bin/ditto', [oldApp, target])
    await writeFile(join(root, 'active.json'), JSON.stringify({ name, mode: name }))
    const enclosure = `<item><title>2.0.0</title><sparkle:version>2</sparkle:version><sparkle:shortVersionString>2.0.0</sparkle:shortVersionString><enclosure url="${origin}/${name === 'corrupt' ? 'corrupt.zip' : 'update.zip'}" sparkle:edSignature="${name === 'wrong-signature' ? wrongSignature : signature}" length="${length}" type="application/octet-stream"/></item>`
    feed = `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Isolated Sparkle Test</title>${name === 'latest' ? '' : enclosure}</channel></rss>`
    const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(join(target, 'Contents/MacOS/Electron'), [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    let spawnError
    child.on('error', (error) => { spawnError = error })
    const deadline = Date.now() + 90_000
    let rows = []
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('Sparkle test interrupted')
      if (spawnError) throw spawnError
      rows = await events(name)
      if (rows.some((row) => row.event === 'fixture-error')) throw new Error(JSON.stringify(rows.find((row) => row.event === 'fixture-error')))
      if (child.exitCode !== null || child.signalCode !== null) {
        if (name !== 'install' || rows.some((row) => row.event === 'updated-relaunched') && rows.filter((row) => row.event === 'will-quit').length === 2) break
      }
      await delay(50)
    }
    await writeFile(join(directory, 'stdout.log'), output)
    assert(Date.now() < deadline, `${name} timed out; see ${directory}`)
    assert.equal(child.exitCode, 0, `${name} exited unexpectedly: ${output}`)
    assert.equal(child.signalCode, null)
    const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(target, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
    assert.equal(version, name === 'install' ? '2.0.0' : '1.0.0')
    const preserved = JSON.parse(await readFile(join(directory, 'userData/preserved.json'), 'utf8'))
    assert.deepEqual(preserved, { marker: name })
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
    const states = rows.filter((row) => row.event === 'status').map((row) => row.detail)
    if (name === 'install') {
      const launches = rows.filter((row) => row.event === 'launched')
      assert.deepEqual(launches.map((row) => row.detail.version), ['1.0.0', '2.0.0'])
      assert.equal(new Set(launches.map((row) => row.detail.executable)).size, 1)
      assert.equal(new Set(launches.map((row) => row.detail.userData)).size, 1)
      assert.equal(new Set(launches.map((row) => row.pid)).size, 2)
    } else if (['wrong-signature', 'corrupt'].includes(name)) {
      assert(states.some((state) => state.phase === 'error' && state.code === 4005), `${name}: expected signature rejection; observed ${JSON.stringify(states.map(({ phase, code, error }) => ({ phase, code, error })))}`)
      assert(!states.some((state) => ['ready', 'installing'].includes(state.phase)), `${name}: rejected archive must never become installable`)
    } else if (name === 'latest') assert(states.some((state) => state.phase === 'latest'))
    else {
      const cancelled = rows.find((row) => ['terminal', 'quit-released'].includes(row.event))
      assert.equal(cancelled?.detail.phase, 'cancelled', `${name}: cancellation did not finish`)
      assert.equal(cancelled.detail.sessionInProgress, false)
      if (name.startsWith('verify-')) assert(rows.some((row) => row.event === name && row.detail.phase === 'verifying'))
      assert(!states.some((state) => state.phase === 'installing'))
    }
    if (['available-cancel', 'check-cancel', 'latest'].includes(name)) assert.equal(archiveRequests.get(name) || 0, 0)
    const record = { name, passed: true, version, initialPid: child.pid, exitCode: child.exitCode, launches: rows.filter((row) => row.event === 'launched'), preserved, phases: states.map((state) => state.phase) }
    results.push(record)
    await writeFile(join(root, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
    console.log(`PASS ${name}: ${version}`)
    await delay(150)
  }
  await writeFile(join(root, 'metadata.json'), `${JSON.stringify({ bundleId, sparkle: sparkleRelease, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), realElectronFixture: true, replacesWholeApplicationTest: false }, null, 2)}\n`)
  console.log(`Sparkle minimal Electron integration: ${results.length}/${results.length} passed`)
} finally {
  await cleanup()
  console.log(`Sparkle test cleanup complete; evidence: ${root}`)
}
