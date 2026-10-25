import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyWindowsRelease } from '../scripts/verify-windows-release.mjs'

const root = await mkdtemp(join(tmpdir(), 'guzi-release-'))
const repository = 'Drangon-Li/Guzi-Assistant'
const version = '0.12.0'
const tag = `v${version}`
const event = { action: 'published', repository: { full_name: repository }, release: { tag_name: tag, draft: false, prerelease: false } }
const current = { tagName: tag, isDraft: false, isPrerelease: false, assets: [{ name: 'GuziAssistant-0.12.0-arm64.dmg' }] }
const names = [`GuziAssistant-${version}-win-x64.exe`, `GuziAssistant-${version}-win-x64.zip`]
const manifest = { version, platform: 'win32', arch: 'x64', installerType: 'nsis', url: `https://github.com/${repository}/releases/download/${tag}/${names[0]}` }
const env = { GITHUB_EVENT_NAME: 'release', GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_REF: `refs/tags/${tag}`, GITHUB_REPOSITORY: repository }
const json = (path, value) => writeFile(join(root, path), JSON.stringify(value))
const verify = (options = {}) => verifyWindowsRelease({ root, env, ...options })

try {
  await json('package.json', { version })
  await json('event.json', event)
  assert.equal((await verify({ tagOnly: true })).tag, tag, 'tag check runs before packaging exists')
  await mkdir(join(root, 'release'))
  await json('release-metadata.json', current)
  await json('release/latest-win-x64.json', manifest)
  const sums = []
  for (const name of names) {
    const data = Buffer.from(`synthetic release fixture: ${name}`)
    await writeFile(join(root, 'release', name), data)
    sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`)
  }
  await writeFile(join(root, 'release/windows-SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  assert.equal((await verify()).assets.length, 4, 'Mac assets may coexist with the Windows assets')

  for (const name of ['push', 'pull_request', 'workflow_dispatch']) {
    await assert.rejects(verify({ env: { ...env, GITHUB_EVENT_NAME: name } }), /Only a published release/)
  }
  for (const release of [
    { ...event.release, draft: true }, { ...event.release, prerelease: true },
    { ...event.release, tag_name: 'v0.11.1' }
  ]) {
    await json('event.json', { ...event, release })
    await assert.rejects(verify({ tagOnly: true }))
  }
  await json('event.json', { ...event, action: 'edited' })
  await assert.rejects(verify({ tagOnly: true }), /published/)
  await json('event.json', event)
  await assert.rejects(verify({ env: { ...env, GITHUB_REF: 'refs/heads/main' } }), /tag/)
  await assert.rejects(verify({ env: { ...env, GITHUB_REPOSITORY: 'other/repository' } }), /repository/)
  await json('package.json', { version: '0.12.0-beta.1' })
  await assert.rejects(verify({ tagOnly: true }), /stable package version/)
  await json('package.json', { version })

  for (const name of [...names, 'latest-win-x64.json', 'windows-SHA256SUMS.txt']) {
    await json('release-metadata.json', { ...current, assets: [{ name }] })
    await assert.rejects(verify(), /Refusing to overwrite/)
  }
  for (const change of [{ isDraft: true }, { isPrerelease: true }, { tagName: 'v0.11.1' }]) {
    await json('release-metadata.json', { ...current, ...change })
    await assert.rejects(verify(), /Target release/)
  }
  await json('release-metadata.json', current)
  for (const change of [{ platform: 'darwin' }, { arch: 'arm64' }, { version: '0.11.1' }, { installerType: 'zip' }, { url: 'https://example.test/app.exe' }]) {
    await json('release/latest-win-x64.json', { ...manifest, ...change })
    await assert.rejects(verify(), /manifest/)
  }
  await json('release/latest-win-x64.json', manifest)
  const binary = join(root, 'release', names[0])
  const original = await readFile(binary)
  await writeFile(binary, Buffer.from('corrupt fixture'))
  await assert.rejects(verify(), /SHA-256/)
  await writeFile(binary, Buffer.alloc(0))
  await assert.rejects(verify(), /empty/)
  await writeFile(binary, original)

  const script = fileURLToPath(new URL('../scripts/verify-windows-release.mjs', import.meta.url))
  for (const mode of [[], ['--tag-only']]) {
    const result = spawnSync(process.execPath, [script, ...mode], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  await rm(join(root, 'release', names[1]))
  const rejected = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.notEqual(rejected.status, 0, 'missing asset must stop the upload step')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'release-metadata.json'), 'utf8')), current, 'validation never changes the release')
  console.log('Windows release event, tag, bundle, checksum and no-overwrite guards passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
