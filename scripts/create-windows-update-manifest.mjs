import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const filename = `GuziAssistant-${version}-win-x64.exe`
const base = process.env.GUZI_ASSISTANT_WINDOWS_DOWNLOAD_BASE_URL || `https://github.com/Drangon-Li/Guzi-Assistant/releases/download/v${version}/`
const download = new URL(filename, base.endsWith('/') ? base : `${base}/`)
if (download.protocol !== 'https:' || download.username || download.password) throw new Error('Windows download base URL must use HTTPS without credentials')
const sums = []
for (const name of [filename, `GuziAssistant-${version}-win-x64.zip`]) {
  const data = await readFile(join(root, 'release', name))
  sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`)
}
await writeFile(join(root, 'release/windows-SHA256SUMS.txt'), `${sums.join('\n')}\n`)
await writeFile(join(root, 'release/latest-win-x64.json'), JSON.stringify({
  version, platform: 'win32', arch: 'x64', installerType: 'nsis', url: download.href,
  notes: 'Windows 10/11 x64 版本'
}, null, 2) + '\n')
console.log('Created Windows manifest and checksums. No files have been published.')
