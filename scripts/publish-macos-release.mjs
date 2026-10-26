import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArguments, provenanceName, readGitHubReleaseByTag, readOptionalGitHubRelease, releaseRepository, sha256, validateExistingDraft, validateStableContinuity } from './macos-release.mjs'
import { verifyRelease } from './verify-macos-release.mjs'

const options = parseArguments(process.argv.slice(2), ['publish'])
const directory = resolve(options.directory ?? 'release')
const { provenance, files } = await verifyRelease(directory)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), provenance.sourceCommit, 'Publishing checkout must match the immutable build source')
const tag = provenance.releaseTag
assert(process.env.GH_TOKEN, 'RELEASE_REPO_TOKEN must be supplied as GH_TOKEN only for this step')
if (options.publish) {
  assert.equal(provenance.channel, 'stable')
  assert.equal(options.confirm, `publish-${tag}`, 'Explicit publish confirmation must match this version')
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Formal publication requires manual workflow dispatch')
} else assert.equal(provenance.channel, 'test', 'Stable publication requires --publish and explicit confirmation')
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function verifyStableContinuity() {
  const latest = readOptionalGitHubRelease(() => JSON.parse(gh(['api', `repos/${releaseRepository}/releases/latest`])))
  if (!latest) return validateStableContinuity(undefined, provenance)
  assert.equal(latest.draft, false)
  assert.equal(latest.prerelease, false)
  const assets = latest.assets.filter((asset) => asset.name === provenanceName)
  assert.equal(assets.length, 1, 'Latest stable release must have exactly one provenance attachment')
  assert(Number.isSafeInteger(assets[0].id) && assets[0].id > 0)
  const previous = JSON.parse(gh(['api', '-H', 'Accept: application/octet-stream', `repos/${releaseRepository}/releases/assets/${assets[0].id}`]))
  assert.equal(previous.releaseTag, latest.tag_name, 'Latest stable provenance does not match its release tag')
  return validateStableContinuity(previous, provenance)
}
if (options.publish) verifyStableContinuity()
const existing = readGitHubReleaseByTag(gh, tag)
const temporary = await mkdtemp(join(tmpdir(), 'guzi-update-publish-'))
try {
  const notes = join(temporary, 'notes.txt')
  const notesText = `GuziAssistant ${provenance.version} (macOS arm64)\n\nSource: ${provenance.sourceRepository}@${provenance.sourceCommit}\nSource tag: ${provenance.sourceTag}\nSparkle: ${provenance.sparkle.version}\n\n${provenance.channel === 'test' ? 'Isolated test application. This draft does not update the stable feed.' : 'Requires macOS 12 or later. Ad-hoc signed; Developer ID notarization is not available.'}\n`
  await writeFile(notes, notesText)
  let uploaded = []
  if (existing) {
    uploaded = validateExistingDraft(existing, { tag, notes: notesText, prerelease: provenance.channel === 'test', files })
    if (uploaded.length) {
      const previous = join(temporary, 'previous')
      gh(['release', 'download', tag, '--repo', releaseRepository, '--dir', previous])
      for (const name of uploaded) assert.equal(await sha256(join(previous, name)), await sha256(join(directory, name)), `Existing draft attachment differs; refusing overwrite: ${name}`)
    }
  } else {
    gh(['release', 'create', tag, '--repo', releaseRepository, '--draft', ...(provenance.channel === 'test' ? ['--prerelease'] : []), '--title', `GuziAssistant ${provenance.version}${provenance.channel === 'test' ? ` test ${provenance.runId}` : ''}`, '--notes-file', notes])
  }
  const missing = files.filter((name) => !uploaded.includes(name))
  if (missing.length) gh(['release', 'upload', tag, '--repo', releaseRepository, ...missing.map((name) => join(directory, name))])
  const downloaded = join(temporary, 'downloaded')
  gh(['release', 'download', tag, '--repo', releaseRepository, '--dir', downloaded])
  assert.deepEqual((await readdir(downloaded)).sort(), [...files].sort(), 'Remote release assets are incomplete')
  for (const name of files) assert.equal(await sha256(join(downloaded, name)), await sha256(join(directory, name)), `Remote bytes changed: ${name}`)
  await verifyRelease(downloaded)
  const remote = readGitHubReleaseByTag(gh, tag)
  assert(remote, 'Release disappeared during verification')
  assert.equal(remote.draft, true, 'Release changed during verification')
  assert.equal(remote.assets.length, files.length)
  if (options.publish) {
    verifyStableContinuity()
    gh(['release', 'edit', tag, '--repo', releaseRepository, '--draft=false', '--prerelease=false', '--latest'])
  }
  console.log(`${options.publish ? 'Published' : 'Verified draft'}: https://github.com/${releaseRepository}/releases/tag/${tag}`)
} finally { await rm(temporary, { recursive: true, force: true }) }
