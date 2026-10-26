import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArguments, releaseRepository, stableAppId, stableFeed, validateUpdateConfig } from './macos-release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export function buildConfig(options, version) {
  const channel = options.channel ?? 'stable'
  const update = validateUpdateConfig({ channel, repository: releaseRepository, appId: options['app-id'] ?? stableAppId, feedUrl: options['feed-url'] ?? stableFeed, publicKey: options['public-key'] ?? process.env.SPARKLE_PUBLIC_KEY, ...(options['profile-dir'] ? { profileDir: options['profile-dir'] } : {}) })
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const testName = `GuziAssistantUpdateTest-${update.appId.split('.').at(-1)}`
  return {
    extends: join(root, 'electron-builder.yml'), appId: update.appId, buildVersion: version,
    ...(channel === 'test' ? { productName: testName, artifactName: `${testName}-\${version}-\${arch}.\${ext}` } : {}),
    directories: { output: resolve(options.output ?? 'release') },
    extraMetadata: { version, guziUpdate: update, ...(channel === 'test' ? { name: testName.toLowerCase(), productName: testName } : {}) },
    mac: { extendInfo: { CFBundleDisplayName: channel === 'test' ? testName : '谷子助手', CFBundleName: channel === 'test' ? testName : 'GuziAssistant' } }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'macOS arm64 is required')
  const options = parseArguments(process.argv.slice(2), ['dir', 'skip-build'])
  for (const key of Object.keys(options)) assert(['channel', 'app-id', 'feed-url', 'public-key', 'profile-dir', 'output', 'version', 'dir', 'skip-build'].includes(key), `Unknown option: ${key}`)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const config = buildConfig(options, options.version ?? pkg.version)
  const temporary = await mkdtemp(join(tmpdir(), 'guzi-update-build-'))
  try {
    const file = join(temporary, 'builder.json')
    await writeFile(file, JSON.stringify(config))
    if (!options['skip-build']) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
    execFileSync(process.execPath, [join(root, 'node_modules/electron-builder/cli.js'), '--mac', '--arm64', ...(options.dir ? ['--dir'] : []), '--publish', 'never', '--config', file], { cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
