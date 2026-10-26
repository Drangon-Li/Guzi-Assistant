import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { buildConfig } from './build-macos-release.mjs'
import { checksumName, feedName, provenanceName, readGitHubReleaseByTag, readOptionalGitHubRelease, releaseRepository, sha256, sourceRepository, stableAppId, stableFeed, validateExistingDraft, validateStableContinuity, validateTag, validateUpdateConfig, verifySignature } from './macos-release.mjs'
import { verifyRelease } from './verify-macos-release.mjs'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
const stable = { channel: 'stable', repository: releaseRepository, appId: stableAppId, feedUrl: stableFeed, publicKey }
const isolated = { ...stable, channel: 'test', appId: 'cn.shilong.gooz.update-test.unit', profileDir: '/private/tmp/guzi-update-unit', feedUrl: 'http://127.0.0.1:4444/appcast.xml' }

test('stable package preserves bundle identity, rejects fallback keys and test data overrides', () => {
  assert.deepEqual(validateUpdateConfig(stable), stable)
  for (const change of [{ publicKey: undefined }, { publicKey: Buffer.alloc(32).toString('base64') }, { publicKey: 'not-a-key' }, { appId: isolated.appId }, { profileDir: isolated.profileDir }, { repository: sourceRepository }, { feedUrl: isolated.feedUrl }]) assert.throws(() => validateUpdateConfig({ ...stable, ...change }))
})

test('test packages require independent app identity, temporary profile and nonproduction feed', () => {
  assert.deepEqual(validateUpdateConfig(isolated), isolated)
  for (const change of [{ appId: stableAppId }, { profileDir: '/Users/example/Library/Application Support/GuziAssistant' }, { profileDir: '/private/tmp/other' }, { profileDir: 'guzi-update-relative' }, { feedUrl: stableFeed }, { feedUrl: 'http://example.org/appcast.xml' }]) assert.throws(() => validateUpdateConfig({ ...isolated, ...change }))
})

test('builder overrides isolate app naming and preserve explicit test version', () => {
  const config = buildConfig({ channel: 'test', 'app-id': isolated.appId, 'profile-dir': isolated.profileDir, 'feed-url': isolated.feedUrl, 'public-key': publicKey, output: '/private/tmp/guzi-update-unit/build' }, '2.0.0')
  assert.equal(config.appId, isolated.appId)
  assert.equal(config.productName, 'GuziAssistantUpdateTest-unit')
  assert.equal(config.extraMetadata.name, 'guziassistantupdatetest-unit')
  assert.equal(config.extraMetadata.version, '2.0.0')
  assert.equal(config.buildVersion, '2.0.0')
  assert.equal(config.extraMetadata.guziUpdate.profileDir, isolated.profileDir)
  assert.equal(buildConfig({ 'public-key': publicKey }, '0.13.0').extraMetadata.guziUpdate.appId, stableAppId)
})

test('release tags must be exact stable SemVer and must match package version', () => {
  validateTag('v0.13.0', '0.13.0')
  for (const tag of ['0.13.0', 'v0.12.0', 'v0.13.0-test', 'refs/tags/v0.13.0']) assert.throws(() => validateTag(tag, '0.13.0'))
  assert.throws(() => validateTag('v0.13.0-beta.1', '0.13.0-beta.1'))
})

test('signature verification rejects corrupted archives and mismatched keys', () => {
  const bytes = Buffer.from('whole signed update archive')
  const signature = sign(null, bytes, keys.privateKey).toString('base64')
  verifySignature(bytes, signature, publicKey)
  assert.throws(() => verifySignature(Buffer.from('corrupted'), signature, publicKey))
  const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  assert.throws(() => verifySignature(bytes, signature, wrong))
  assert.throws(() => verifySignature(bytes, 'invalid', publicKey))
})

test('partial draft recovery only permits the same source and expected attachment names', () => {
  const draft = { draft: true, tag_name: 'v0.13.0-test-123', body: 'Source: immutable-sha\n', prerelease: true, assets: [{ name: 'app.zip' }] }
  const expected = { tag: draft.tag_name, notes: draft.body, prerelease: true, files: ['app.zip', 'app.dmg'] }
  assert.deepEqual(validateExistingDraft(draft, expected), ['app.zip'])
  for (const change of [{ draft: false }, { body: 'Source: another-sha\n' }, { prerelease: false }, { assets: [{ name: 'unknown.zip' }] }, { assets: [{ name: 'app.zip' }, { name: 'app.zip' }] }]) assert.throws(() => validateExistingDraft({ ...draft, ...change }, expected))
})

test('first stable publication and higher versions retain the same signing identity', () => {
  const previous = { ...stable, version: '0.13.0', releaseTag: 'v0.13.0' }
  const next = { ...stable, version: '0.14.0', releaseTag: 'v0.14.0' }
  assert.equal(validateStableContinuity(undefined, next), 'first-release')
  assert.equal(validateStableContinuity(previous, next), 'upgrade')
  assert.equal(validateStableContinuity(previous, { ...next, version: '1.0.0', releaseTag: 'v1.0.0' }), 'upgrade')
  assert.equal(validateStableContinuity({ ...previous, version: '0.9.9', releaseTag: 'v0.9.9' }, { ...next, version: '0.10.0', releaseTag: 'v0.10.0' }), 'upgrade')
})

test('stable key rotation, same versions and rollback versions fail closed', () => {
  const previous = { ...stable, version: '0.13.0', releaseTag: 'v0.13.0' }
  const next = { ...stable, version: '0.14.0', releaseTag: 'v0.14.0' }
  const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  assert.throws(() => validateStableContinuity(previous, { ...next, publicKey: wrong }), /dedicated key migration/)
  for (const version of ['0.13.0', '0.12.99', '0.0.1']) assert.throws(() => validateStableContinuity(previous, { ...next, version, releaseTag: `v${version}` }), /rollback requires repackaging/)
  assert.throws(() => validateStableContinuity(previous, { ...next, channel: 'test' }))
})

test('only an explicit GitHub HTTP 404 indicates an absent stable release', () => {
  const error = (stderr) => Object.assign(new Error('gh failed'), { stderr })
  assert.equal(readOptionalGitHubRelease(() => { throw error('gh: Not Found (HTTP 404)\n') }), undefined)
  const release = { tag_name: 'v0.13.0' }
  assert.equal(readOptionalGitHubRelease(() => release), release)
  for (const message of ['gh: Forbidden (HTTP 403)\n', 'gh: Rate limit exceeded (HTTP 429)\n', 'getaddrinfo ENOTFOUND github.com', 'unexpected response']) assert.throws(() => readOptionalGitHubRelease(() => { throw error(message) }))
})

test('release lookup finds an untagged draft across authenticated pages and reads it by ID', () => {
  const tag = 'v0.13.0'
  const draft = { id: 42, tag_name: tag, draft: true, assets: [] }
  const calls = []
  const result = readGitHubReleaseByTag((args) => {
    calls.push(args)
    if (calls.length === 1) return JSON.stringify([[{ id: 1, tag_name: `${tag}-test` }], [draft]])
    assert.deepEqual(args, ['api', `repos/${releaseRepository}/releases/42`])
    return JSON.stringify(draft)
  }, tag)
  assert.deepEqual(calls[0], ['api', '--paginate', '--slurp', `repos/${releaseRepository}/releases?per_page=100`])
  assert.equal(calls.length, 2)
  assert.deepEqual(result, draft)
})

test('release lookup retains published matches so publication cannot overwrite them', () => {
  const published = { id: 42, tag_name: 'v0.13.0', draft: false }
  const gh = (args) => JSON.stringify(args.includes('--paginate') ? [[published]] : published)
  const existing = readGitHubReleaseByTag(gh, published.tag_name)
  assert.throws(() => validateExistingDraft(existing, { tag: published.tag_name }), /Published releases can never be overwritten/)
})

test('release lookup only reports absence after a complete successful list', () => {
  let calls = 0
  assert.equal(readGitHubReleaseByTag(() => {
    calls++
    return JSON.stringify([[{ id: 1, tag_name: 'v0.13.0-test' }], []])
  }, 'v0.13.0'), undefined)
  assert.equal(calls, 1)
  for (const status of [404, 403, 429]) {
    const error = Object.assign(new Error('gh failed'), { stderr: `gh: request failed (HTTP ${status})\n` })
    assert.throws(() => readGitHubReleaseByTag(() => { throw error }, 'v0.13.0'), (thrown) => thrown === error)
  }
})

test('release lookup rejects duplicate tags, invalid IDs and releases changed during lookup', () => {
  const release = { id: 42, tag_name: 'v0.13.0', draft: true }
  assert.throws(() => readGitHubReleaseByTag(() => JSON.stringify([[release], [{ ...release, id: 43 }]]), release.tag_name), /Multiple GitHub releases/)
  assert.throws(() => readGitHubReleaseByTag(() => JSON.stringify([[{ ...release, id: undefined }]]), release.tag_name), /valid ID/)
  for (const changed of [{ ...release, id: 43 }, { ...release, tag_name: 'v0.14.0' }]) {
    const gh = (args) => JSON.stringify(args.includes('--paginate') ? [[release]] : changed)
    assert.throws(() => readGitHubReleaseByTag(gh, release.tag_name), /changed during lookup/)
  }
})

test('release verifier detects incomplete assets, tampering and wrong provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guzi-update-release-test-'))
  try {
    const zip = 'GuziAssistant-0.13.0-arm64.zip', dmg = 'GuziAssistant-0.13.0-arm64.dmg'
    const bytes = Buffer.from('signed ZIP fixture')
    await writeFile(join(directory, zip), bytes)
    await writeFile(join(directory, dmg), 'DMG fixture')
    const signature = sign(null, bytes, keys.privateKey).toString('base64')
    const provenance = { sourceRepository, repository: releaseRepository, sourceCommit: 'a'.repeat(40), sourceTag: 'v0.13.0', releaseTag: 'v0.13.0', version: '0.13.0', channel: 'stable', arch: 'arm64', minimumMacOS: '12.0', electronVersion: '38.8.6', publicKey, zip, dmg, length: bytes.length, zipSha256: await sha256(join(directory, zip)), dmgSha256: await sha256(join(directory, dmg)), signature, sparkle: JSON.parse(await readFile(new URL('./sparkle-release.json', import.meta.url), 'utf8')) }
    const url = `https://github.com/${releaseRepository}/releases/download/v0.13.0/${zip}`
    const feed = `<?xml version="1.0" encoding="utf-8"?><sparkle:version>0.13.0</sparkle:version><sparkle:shortVersionString>0.13.0</sparkle:shortVersionString><sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion><enclosure url="${url}" sparkle:edSignature="${signature}" length="${bytes.length}"/>`
    await writeFile(join(directory, feedName), feed)
    const save = async () => {
      await writeFile(join(directory, provenanceName), JSON.stringify(provenance))
      const names = [zip, dmg, feedName, provenanceName]
      await writeFile(join(directory, checksumName), (await Promise.all(names.map(async (name) => `${await sha256(join(directory, name))}  ${name}`))).join('\n') + '\n')
    }
    await save()
    assert.equal((await verifyRelease(directory, { archives: false })).files.length, 5)
    await writeFile(join(directory, zip), 'corrupted ZIP')
    await assert.rejects(verifyRelease(directory, { archives: false }), /Checksum mismatch/)
    await writeFile(join(directory, zip), bytes)
    provenance.sourceTag = 'v0.12.0'
    await save()
    await assert.rejects(verifyRelease(directory, { archives: false }), /match package version/)
    provenance.sourceTag = 'v0.13.0'
    await save()
    await rm(join(directory, dmg))
    await assert.rejects(verifyRelease(directory, { archives: false }), /ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('workflow keeps write token and signing secret scoped to their steps', async () => {
  const require = createRequire(import.meta.url)
  const workflow = require('js-yaml').load(await readFile(new URL('../.github/workflows/macos-release.yml', import.meta.url), 'utf8'))
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.jobs.publish.environment, 'macos-release')
  assert.deepEqual(workflow.jobs.publish.concurrency, { group: 'macos-stable-publication', 'cancel-in-progress': false })
  assert.match(workflow.jobs.publish.if, /workflow_dispatch/)
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'macos-15')
    assert(!JSON.stringify(job.env ?? {}).includes('PRIVATE_KEY'))
    assert(!JSON.stringify(job.env ?? {}).includes('RELEASE_REPO_TOKEN'))
    for (const step of job.steps) {
      if (JSON.stringify(step).includes('secrets.SPARKLE_PRIVATE_KEY')) assert.match(step.run, /sign-macos-release/)
      if (JSON.stringify(step).includes('secrets.RELEASE_REPO_TOKEN')) assert.match(step.run, /publish-macos-release/)
    }
  }
  assert(workflow.jobs.build.steps.some((step) => step.run === 'node scripts/test-macos-app-update.mjs' && !step['continue-on-error']))
})
