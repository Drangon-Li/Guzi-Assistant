import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checksumName, feedName, parseArguments, provenanceName, releaseRepository, sha256, sourceRepository, sparkleLicenseSha256, validateTag, validateUpdateConfig, verifySignature, xml } from './macos-release.mjs'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim()
const plist = (file, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file])

export async function verifyBundle(app, expected) {
  assert.equal(process.platform, 'darwin', 'Bundle verification requires macOS')
  const info = join(app, 'Contents/Info.plist')
  assert.equal(await sha256(join(app, 'Contents/Resources/licenses/Sparkle-LICENSE.txt')), sparkleLicenseSha256, 'Sparkle license must match the pinned upstream release')
  const { extractFile } = require('@electron/asar')
  const pkg = JSON.parse(extractFile(join(app, 'Contents/Resources/app.asar'), 'package.json').toString())
  const update = validateUpdateConfig(pkg.guziUpdate)
  assert.equal(pkg.version, expected.version)
  assert.equal(update.channel, expected.channel)
  assert.equal(update.publicKey, expected.publicKey)
  if (expected.appId) assert.equal(update.appId, expected.appId)
  if (expected.feedUrl) assert.equal(update.feedUrl, expected.feedUrl)
  for (const [key, value] of Object.entries({ CFBundleIdentifier: update.appId, CFBundleShortVersionString: expected.version, CFBundleVersion: expected.version, LSMinimumSystemVersion: '12.0', SUFeedURL: update.feedUrl, SUPublicEDKey: update.publicKey, SUVerifyUpdateBeforeExtraction: 'true', SUAutomaticallyUpdate: 'false', SUAllowsAutomaticUpdates: 'false', SUEnableAutomaticChecks: 'false' })) assert.equal(plist(info, key), value, key)
  const executable = plist(info, 'CFBundleExecutable')
  assert.equal(plist(info, 'CFBundleName'), executable)
  assert.equal(executable, update.channel === 'stable' ? 'GuziAssistant' : `GuziAssistantUpdateTest-${update.appId.split('.').at(-1)}`)
  for (const file of [join(app, 'Contents/MacOS', executable), join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'), join(app, 'Contents/Frameworks/Sparkle.framework/Sparkle'), join(app, 'Contents/Resources/native/sparkle-bridge.node')]) {
    const architectures = run('/usr/bin/lipo', ['-archs', file]).split(' ')
    assert(architectures.includes('arm64'), `${file} must support arm64`)
    if (!file.includes('Sparkle.framework')) assert.deepEqual(architectures, ['arm64'])
  }
  const electron = plist(join(app, 'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist'), 'CFBundleVersion')
  assert.equal(electron, '38.8.6', 'Release Electron version must be pinned')
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  return update
}

async function singleApp(directory) {
  const apps = (await readdir(directory)).filter((name) => name.endsWith('.app'))
  assert.equal(apps.length, 1, `Expected one application in ${directory}`)
  return join(directory, apps[0])
}

export async function verifyArchives(directory, provenance) {
  const temporary = await mkdtemp(join(tmpdir(), 'guzi-update-verify-'))
  try {
    const unpacked = join(temporary, 'zip')
    run('/usr/bin/ditto', ['-x', '-k', join(directory, provenance.zip), unpacked])
    const update = await verifyBundle(await singleApp(unpacked), provenance)
    if (provenance.dmg) {
      const mount = join(temporary, 'dmg')
      run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, join(directory, provenance.dmg)])
      try { assert.deepEqual(await verifyBundle(await singleApp(mount), provenance), update) }
      finally { run('/usr/bin/hdiutil', ['detach', mount]) }
    }
    return update
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function verifyRelease(directory, { archives = true } = {}) {
  const provenance = JSON.parse(await readFile(join(directory, provenanceName), 'utf8'))
  assert.equal(provenance.sourceRepository, sourceRepository)
  assert.equal(provenance.repository, releaseRepository)
  assert.match(provenance.sourceCommit, /^[a-f0-9]{40}$/)
  validateTag(provenance.sourceTag, provenance.version)
  const expectedTag = provenance.channel === 'stable' ? provenance.sourceTag : `${provenance.sourceTag}-test-${provenance.runId}`
  assert.equal(provenance.releaseTag, expectedTag)
  assert.equal(provenance.arch, 'arm64')
  assert.equal(provenance.minimumMacOS, '12.0')
  assert.equal(provenance.electronVersion, '38.8.6')
  assert.deepEqual(provenance.sparkle, JSON.parse(await readFile(join(root, 'scripts/sparkle-release.json'), 'utf8')), 'Sparkle provenance must match the pinned upstream release')
  for (const name of [provenance.zip, provenance.dmg]) assert(name && basename(name) === name && /^[-.a-zA-Z0-9]+$/.test(name), 'Invalid archive name')
  assert.equal(provenance.zip, provenance.channel === 'stable' ? `GuziAssistant-${provenance.version}-arm64.zip` : `${provenance.productName}-${provenance.version}-arm64.zip`)
  assert.equal(provenance.dmg, provenance.zip.replace(/\.zip$/, '.dmg'))
  const checksumLines = (await readFile(join(directory, checksumName), 'utf8')).trim().split('\n')
  const expectedNames = [provenance.zip, provenance.dmg, feedName, provenanceName]
  assert.equal(checksumLines.length, expectedNames.length)
  for (const [index, name] of expectedNames.entries()) assert.equal(checksumLines[index], `${await sha256(join(directory, name))}  ${name}`, `Checksum mismatch: ${name}`)
  const zipBytes = await readFile(join(directory, provenance.zip))
  assert.equal(zipBytes.length, provenance.length)
  assert.equal(await sha256(join(directory, provenance.zip)), provenance.zipSha256)
  assert.equal(await sha256(join(directory, provenance.dmg)), provenance.dmgSha256)
  verifySignature(zipBytes, provenance.signature, provenance.publicKey)
  const feed = await readFile(join(directory, feedName), 'utf8')
  assert(feed.startsWith('<?xml version="1.0" encoding="utf-8"?>'))
  const url = `https://github.com/${releaseRepository}/releases/download/${provenance.releaseTag}/${provenance.zip}`
  for (const fragment of [`<sparkle:version>${xml(provenance.version)}</sparkle:version>`, `<sparkle:shortVersionString>${xml(provenance.version)}</sparkle:shortVersionString>`, '<sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>', `url="${xml(url)}"`, `sparkle:edSignature="${xml(provenance.signature)}"`, `length="${provenance.length}"`]) assert(feed.includes(fragment), `Missing appcast field: ${fragment}`)
  assert.equal((feed.match(/<enclosure /g) ?? []).length, 1)
  if (archives) await verifyArchives(directory, provenance)
  return { provenance, files: [...expectedNames, checksumName] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2), ['source', 'tag-only'])
  if (options.source || options['tag-only']) {
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
    validateTag(options.tag ?? process.env.RELEASE_TAG, version)
    if (options.source) {
      const sha = run('git', ['rev-parse', 'HEAD'])
      assert.equal(run('git', ['rev-parse', `${options.tag ?? process.env.RELEASE_TAG}^{commit}`]), sha, 'Checkout must match the release tag')
      run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'])
      assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Release source must be clean')
    }
  } else {
    const result = await verifyRelease(resolve(options.directory ?? 'release'))
    console.log(`Verified ${result.provenance.releaseTag}: ${result.files.length} macOS release assets`)
  }
}
