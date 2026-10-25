import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build Windows packages on a Windows x64 machine or CI runner')
const root = fileURLToPath(new URL('../', import.meta.url))
function run(command, args, shell = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
run('npm.cmd', ['ci', '--prefix', 'windows-runtime', '--no-audit', '--no-fund'], true)
run(process.execPath, ['scripts/prepare-windows-ocr.mjs'])
run(process.execPath, ['scripts/build-windows-helper.mjs'])
