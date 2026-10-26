import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checksumName, feedName, parseArguments, provenanceName, releaseRepository, sha256, sourceRepository, validateTag, verifySignature, xml } from './macos-release.mjs'
import { verifyArchives, verifyRelease } from './verify-macos-release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const options = parseArguments(process.argv.slice(2))
const secret = process.env.SPARKLE_PRIVATE_KEY
delete process.env.SPARKLE_PRIVATE_KEY
const directory = resolve(options.directory ?? 'release')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const sourceTag = options.tag ?? process.env.RELEASE_TAG
validateTag(sourceTag, version)
const channel = options.channel ?? 'test'
assert(['stable', 'test'].includes(channel))
const runId = options['run-id'] ?? process.env.GITHUB_RUN_ID
assert.match(runId ?? '', /^\d+$/)
const releaseTag = channel === 'stable' ? sourceTag : `${sourceTag}-test-${runId}`
const files = await readdir(directory)
const zips = files.filter((name) => name.endsWith('-arm64.zip'))
assert.equal(zips.length, 1, 'Release directory must contain exactly one arm64 ZIP')
const zip = zips[0], dmg = zip.replace(/\.zip$/, '.dmg')
await stat(join(directory, dmg))
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const provenance = { schemaVersion: 1, sourceRepository, sourceCommit, sourceTag, repository: releaseRepository, releaseTag, runId, version, channel, arch: 'arm64', minimumMacOS: '12.0', electronVersion: '38.8.6', productName: zip.slice(0, -`-${version}-arm64.zip`.length), publicKey: process.env.SPARKLE_PUBLIC_KEY, zip, dmg, length: (await stat(join(directory, zip))).size, zipSha256: await sha256(join(directory, zip)), dmgSha256: await sha256(join(directory, dmg)), sparkle: JSON.parse(await readFile(join(root, 'scripts/sparkle-release.json'), 'utf8')) }
// Reject incorrectly built archives before exposing the signing secret to a subprocess.
const update = await verifyArchives(directory, provenance)
Object.assign(provenance, { appId: update.appId, feedUrl: update.feedUrl })
assert(secret && /^[A-Za-z0-9+/]+={0,2}$/.test(secret.trim()), 'SPARKLE_PRIVATE_KEY is required')
const temporary = await mkdtemp(join(tmpdir(), 'guzi-update-sign-'))
try {
  const keyFile = join(temporary, 'private-key')
  await writeFile(keyFile, secret.trim(), { mode: 0o600 })
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
  const signer = join(root, 'build/sparkle/bin/sign_update')
  provenance.signature = execFileSync(signer, ['--ed-key-file', keyFile, '-p', join(directory, zip)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  verifySignature(await readFile(join(directory, zip)), provenance.signature, provenance.publicKey)
  execFileSync(signer, ['--verify', '--ed-key-file', keyFile, join(directory, zip), provenance.signature], { stdio: ['ignore', 'pipe', 'pipe'] })
  const url = `https://github.com/${releaseRepository}/releases/download/${releaseTag}/${zip}`
  await writeFile(join(directory, feedName), `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>GuziAssistant macOS arm64</title><item><title>${xml(version)}</title><sparkle:version>${xml(version)}</sparkle:version><sparkle:shortVersionString>${xml(version)}</sparkle:shortVersionString><sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion><enclosure url="${xml(url)}" sparkle:edSignature="${xml(provenance.signature)}" length="${provenance.length}" type="application/octet-stream"/></item></channel></rss>\n`)
  await writeFile(join(directory, provenanceName), `${JSON.stringify(provenance, null, 2)}\n`)
  const checksums = await Promise.all([zip, dmg, feedName, provenanceName].map(async (name) => `${await sha256(join(directory, name))}  ${name}`))
  await writeFile(join(directory, checksumName), `${checksums.join('\n')}\n`)
} finally { await rm(temporary, { recursive: true, force: true }) }
await verifyRelease(directory, { archives: false })
console.log(`Signed and verified ${releaseTag}; private key removed`)
