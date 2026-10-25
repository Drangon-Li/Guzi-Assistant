import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export async function verifyWindowsRelease({ root = process.cwd(), env = process.env, tagOnly = false } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'release') throw new Error('Only a published release can upload Windows assets')
  const event = await readJson(env.GITHUB_EVENT_PATH)
  const release = event.release
  if (event.action !== 'published' || release?.draft !== false || release?.prerelease !== false) {
    throw new Error('Windows assets require a published, non-draft, stable release')
  }
  const { version } = await readJson(join(root, 'package.json'))
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Windows releases require a stable package version')
  }
  const tag = `v${version}`
  if (release.tag_name !== tag || env.GITHUB_REF !== `refs/tags/${tag}`) {
    throw new Error('Release tag must match package.json version and the workflow tag ref')
  }
  const repository = env.GITHUB_REPOSITORY
  if (!repository || event.repository?.full_name !== repository) throw new Error('Release repository mismatch')
  const binaries = [`GuziAssistant-${version}-win-x64.exe`, `GuziAssistant-${version}-win-x64.zip`]
  const assets = [...binaries, 'windows-SHA256SUMS.txt', 'latest-win-x64.json']
  if (tagOnly) return { tag, version, assets }

  const current = await readJson(join(root, 'release-metadata.json'))
  if (current.tagName !== tag || current.isDraft !== false || current.isPrerelease !== false || !Array.isArray(current.assets)) {
    throw new Error('Target release is no longer a published stable release with the expected tag')
  }
  const existing = current.assets.filter((asset) => assets.includes(asset.name)).map((asset) => asset.name)
  if (existing.length) throw new Error(`Refusing to overwrite existing release assets: ${existing.join(', ')}`)

  const directory = join(root, 'release')
  const manifest = await readJson(join(directory, 'latest-win-x64.json'))
  const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${binaries[0]}`
  if (manifest.version !== version || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.installerType !== 'nsis' || manifest.url !== expectedUrl) {
    throw new Error('Windows manifest must describe this release and its x64 NSIS installer')
  }
  const sums = []
  for (const name of binaries) {
    const path = join(directory, name)
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty Windows asset: ${name}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    sums.push(`${hash.digest('hex')}  ${name}`)
  }
  const checksums = await readFile(join(directory, 'windows-SHA256SUMS.txt'), 'utf8')
  if (checksums !== `${sums.join('\n')}\n`) throw new Error('Windows asset SHA-256 checksums do not match')
  return { tag, version, assets }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyWindowsRelease({ tagOnly: process.argv.includes('--tag-only') })
    console.log(`Validated Windows release ${result.tag}${process.argv.includes('--tag-only') ? ' tag' : ' assets'}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
