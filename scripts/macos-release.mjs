import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, basename, join } from 'node:path'

export const sourceRepository = 'Drangon-Li/Guzi-Assistant'
/** 源码仓库公开后，安装包与 Sparkle 更新源直接发布在源码仓库的 Releases 里，不再另设发布仓库。 */
export const releaseRepository = sourceRepository
/**
 * v0.13.0–v0.14.0 发布在这里，这些安装包写死从它读更新源。迁移版本发布时用 --bridge-legacy
 * 在这里放一份指向新仓库安装包的更新源，老用户升到迁移版本后就改读新仓库；之后本仓库归档即可。
 */
export const legacyReleaseRepository = 'Drangon-Li/guzi-assistant-releases'
export const stableAppId = 'cn.shilong.gooz'
export const stableFeed = `https://github.com/${releaseRepository}/releases/latest/download/appcast-mac-arm64.xml`
export const legacyStableFeed = `https://github.com/${legacyReleaseRepository}/releases/latest/download/appcast-mac-arm64.xml`
export const feedName = 'appcast-mac-arm64.xml'
export const checksumName = 'mac-arm64-SHA256SUMS.txt'
export const provenanceName = 'mac-arm64-provenance.json'
export const sparkleLicenseSha256 = '389a4e4e9a32f059775b13a06e25a591445ba229d2838d26dd3e7c0c45127cfe'

export function publicKeyBytes(value) {
  assert.equal(typeof value, 'string', 'SPARKLE_PUBLIC_KEY is required')
  const bytes = Buffer.from(value, 'base64')
  assert(bytes.length === 32 && bytes.toString('base64') === value && bytes.some((byte) => byte !== 0), 'Sparkle public key must be a canonical nonzero 32-byte base64 Ed25519 key')
  return bytes
}

export function validateUpdateConfig(config) {
  assert(config && ['stable', 'test'].includes(config.channel), 'guziUpdate.channel is required')
  assert.equal(config.repository, releaseRepository)
  publicKeyBytes(config.publicKey)
  const url = new URL(config.feedUrl)
  if (config.channel === 'stable') {
    assert.equal(config.appId, stableAppId)
    assert.equal(config.feedUrl, stableFeed)
    assert.equal(config.profileDir, undefined, 'Stable packages cannot override user data')
  } else {
    assert.match(config.appId, /^cn\.shilong\.gooz\.update-test\.[a-zA-Z0-9-]+$/)
    assert(isAbsolute(config.profileDir ?? '') && /^guzi-update-/.test(basename(config.profileDir)), 'Test profile must use an absolute guzi-update-* temporary directory')
    assert(/^\/(private\/)?(var\/folders\/[^/]+\/[^/]+\/T|tmp)\//.test(config.profileDir), 'Test profile must be in the macOS temporary directory')
    assert.notEqual(config.feedUrl, stableFeed)
    assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Test feeds require HTTPS or loopback HTTP')
  }
  return config
}

export function validateTag(tag, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(tag, `v${version}`, 'Release source tag must match package version exactly')
}

export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function verifySignature(bytes, signature, publicKey) {
  assert.equal(Buffer.from(signature, 'base64').length, 64, 'Invalid Ed25519 signature length')
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyBytes(publicKey)]), format: 'der', type: 'spki' })
  assert(verify(null, bytes, key, Buffer.from(signature, 'base64')), 'Sparkle Ed25519 signature does not match packaged public key')
}

export function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;') }

export function validateExistingDraft(existing, { tag, notes, prerelease, files }) {
  assert.equal(existing.draft, true, 'Published releases can never be overwritten')
  assert.equal(existing.tag_name, tag)
  assert.equal(existing.body, notes, 'Existing draft belongs to a different source build')
  assert.equal(existing.prerelease, prerelease)
  const names = existing.assets.map((asset) => asset.name)
  assert.equal(new Set(names).size, names.length, 'Duplicate draft attachments')
  for (const name of names) assert(files.includes(name), `Unexpected draft attachment: ${name}`)
  return names
}

export function readOptionalGitHubRelease(read) {
  try { return read() }
  catch (error) {
    if (/\(HTTP 404\)(?:\r?\n|$)/.test(String(error.stderr))) return undefined
    throw error
  }
}

export function readGitHubReleaseByTag(gh, tag, repository = releaseRepository) {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]))
  assert(Array.isArray(pages) && pages.every(Array.isArray), 'Expected paginated GitHub release lists')
  const matches = pages.flat().filter((release) => release.tag_name === tag)
  assert(matches.length <= 1, `Multiple GitHub releases use tag: ${tag}`)
  if (!matches.length) return undefined
  const { id } = matches[0]
  assert(Number.isSafeInteger(id) && id > 0, 'GitHub release must have a valid ID')
  const release = JSON.parse(gh(['api', `repos/${repository}/releases/${id}`]))
  assert.equal(release.id, id, 'GitHub release ID changed during lookup')
  assert.equal(release.tag_name, tag, 'GitHub release tag changed during lookup')
  return release
}

export function validateStableContinuity(previous, current) {
  const validate = (record, repositories) => {
    assert.equal(record.channel, 'stable')
    assert(repositories.includes(record.repository), `Unexpected release repository: ${record.repository}`)
    assert.equal(record.appId, stableAppId)
    publicKeyBytes(record.publicKey)
    validateTag(record.releaseTag, record.version)
  }
  validate(current, [releaseRepository])
  if (!previous) return 'first-release'
  // 迁移版本的上一个正式版还在旧发布仓库：签名密钥与版本递增照样要连续
  validate(previous, [releaseRepository, legacyReleaseRepository])
  assert.equal(current.publicKey, previous.publicKey, 'Stable signing key changes require a dedicated key migration; automatic publication is blocked')
  const before = previous.version.split('.').map(BigInt)
  const after = current.version.split('.').map(BigInt)
  const changed = after.findIndex((part, index) => part !== before[index])
  assert(changed !== -1 && after[changed] > before[changed], 'Stable versions must strictly increase; rollback requires repackaging and publishing a higher version')
  return 'upgrade'
}

export function parseArguments(argv, booleans = []) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    assert(argv[i].startsWith('--'), `Unexpected argument: ${argv[i]}`)
    const key = argv[i].slice(2)
    assert(!Object.hasOwn(options, key), `Duplicate argument: ${key}`)
    if (booleans.includes(key)) options[key] = true
    else { assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing argument: ${key}`); options[key] = argv[++i] }
  }
  return options
}

/**
 * 旧安装（v0.13.0–v0.14.0）写死从旧发布仓库的 latest 读更新源。在那里放一份同样的 appcast——
 * 它的下载地址指向源码仓库刚发布的 ZIP，EdDSA 签名照常校验——老用户升到这个版本后就改读新仓库。
 * gh 需带旧仓库写权限；已发布过就只核对字节，不覆盖。返回旧仓库里这个发布的地址。
 */
export async function bridgeLegacyFeed({ gh, directory, temporary, tag, zip }) {
  const feed = await readFile(join(directory, feedName), 'utf8')
  assert(feed.includes(`https://github.com/${releaseRepository}/releases/download/${tag}/${zip}`), 'Bridged feed must point at the archive just published in the source repository')
  const bridged = [feedName, provenanceName, checksumName]
  const notes = join(temporary, 'bridge-notes.txt')
  await writeFile(notes, `谷子助手已迁移到开源仓库 https://github.com/${releaseRepository} 。\n\n本发布只用于把旧版本（v0.13.0–v0.14.0）的应用内更新引导到新地址，安装包请到 https://github.com/${releaseRepository}/releases/tag/${tag} 下载。\n`)
  const existing = readGitHubReleaseByTag(gh, tag, legacyReleaseRepository)
  if (!existing) gh(['release', 'create', tag, '--repo', legacyReleaseRepository, '--draft', '--title', `谷子助手 ${tag} · 迁移到开源仓库`, '--notes-file', notes])
  if (!existing || existing.draft) {
    const present = (existing?.assets ?? []).map((asset) => asset.name)
    for (const name of present) assert(bridged.includes(name), `Unexpected legacy draft attachment: ${name}`)
    const missing = bridged.filter((name) => !present.includes(name))
    if (missing.length) gh(['release', 'upload', tag, '--repo', legacyReleaseRepository, ...missing.map((name) => join(directory, name))])
  }
  const downloaded = join(temporary, 'legacy-bridge')
  gh(['release', 'download', tag, '--repo', legacyReleaseRepository, '--dir', downloaded])
  assert.deepEqual((await readdir(downloaded)).sort(), [...bridged].sort(), 'Legacy bridge assets are incomplete')
  for (const name of bridged) assert.equal(await sha256(join(downloaded, name)), await sha256(join(directory, name)), `Legacy bridge bytes changed: ${name}`)
  if (!existing || existing.draft) gh(['release', 'edit', tag, '--repo', legacyReleaseRepository, '--draft=false', '--prerelease=false', '--latest'])
  return `https://github.com/${legacyReleaseRepository}/releases/tag/${tag}`
}

