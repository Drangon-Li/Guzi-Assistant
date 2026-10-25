import assert from 'node:assert/strict'
import { updateFeed, parseUpdateManifest, isNewerVersion } from '../src/shared/update-manifest.ts'

assert.match(updateFeed('darwin', 'arm64'), /latest-mac\.json$/)
assert.match(updateFeed('win32', 'x64'), /latest-win-x64\.json$/)
assert.throws(() => updateFeed('win32', 'arm64'), /更新源/)
assert.equal(updateFeed('win32', 'x64', 'https://example.test/feed'), 'https://example.test/feed')
const manifest = { version: 'v0.12.0', platform: 'win32', arch: 'x64', installerType: 'nsis', url: 'https://example.test/GuziAssistant.exe' }
assert.equal(parseUpdateManifest(manifest, 'win32', 'x64').version, '0.12.0')
for (const change of [
  { platform: 'darwin' }, { arch: 'arm64' }, { installerType: 'zip' },
  { platform: undefined }, { url: 'https://example.test/app.dmg' },
  { url: 'http://example.test/app.exe' }, { url: 'https://user:pass@example.test/app.exe' },
  { version: 'garbage' }, { version: '0.12.0-beta' }
]) assert.throws(() => parseUpdateManifest({ ...manifest, ...change }, 'win32', 'x64'))
assert.equal(parseUpdateManifest({ version: '0.11.1', url: 'https://example.test/app.dmg' }, 'darwin', 'arm64').version, '0.11.1')
assert.equal(isNewerVersion('0.12.0', '0.11.1'), true)
assert.equal(isNewerVersion('0.11.1', '0.11.1'), false)
assert.equal(isNewerVersion('0.10.9', '0.11.1'), false)
console.log('Platform-specific update feeds and installer validation passed')
