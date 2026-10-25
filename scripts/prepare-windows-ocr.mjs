import { createHash } from 'node:crypto'
import { mkdir, readFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'scripts/windows-ocr-assets.json'), 'utf8'))
const dir = resolve(root, 'build/windows-ocr')
const packageDirectory = resolve(root, 'windows-runtime/node_modules', manifest.package)
const installed = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'))
if (installed.version !== manifest.version) throw new Error('OCR model package version differs from the verified manifest')
await mkdir(dir, { recursive: true })
for (const entry of manifest.files) {
  const target = resolve(dir, entry.name)
  const valid = (data) => createHash('sha256').update(data).digest('hex') === entry.sha256
  if (await readFile(target).then(valid).catch(() => false)) continue
  const source = resolve(packageDirectory, 'assets', entry.name)
  const data = await readFile(source)
  if (!valid(data)) throw new Error(`OCR asset checksum mismatch: ${entry.name}`)
  await copyFile(source, target)
  console.log(`Verified ${entry.name}`)
}
await copyFile(resolve(root, 'windows-runtime/THIRD-PARTY-NOTICES.txt'), resolve(dir, 'THIRD-PARTY-NOTICES.txt'))
await copyFile(resolve(root, 'windows-runtime/PADDLEOCR-LICENSE.txt'), resolve(dir, 'PADDLEOCR-LICENSE.txt'))
