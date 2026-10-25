import { mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows helper must be built on Windows x64')
mkdirSync(resolve(root, 'build/native'), { recursive: true })
const args = ['/nologo', '/std:c++17', '/EHsc', '/O2', '/W4', '/utf-8', '/MT', '/DUNICODE', '/D_UNICODE', '/DWIN32_LEAN_AND_MEAN', '/DNOMINMAX',
  'src\\main\\native\\windows\\GuziWindowsHelper.cpp', '/Febuild\\native\\GuziWindowsHelper.exe', '/Fobuild\\native\\',
  '/link', 'user32.lib', 'ole32.lib', 'oleaut32.lib', 'uiautomationcore.lib', 'shell32.lib', 'version.lib', 'windowscodecs.lib', 'gdi32.lib']
let result
if (spawnSync('cl.exe', [], { stdio: 'ignore' }).error?.code !== 'ENOENT') {
  result = spawnSync('cl.exe', args, { cwd: root, stdio: 'inherit' })
} else {
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!existsSync(vswhere)) throw new Error('Build requires Visual Studio Build Tools with Desktop development with C++')
  const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' })
  const install = found.stdout?.trim()
  if (found.status !== 0 || !install) throw new Error('Visual C++ x64 toolchain not found')
  const setup = join(install, 'Common7/Tools/VsDevCmd.bat')
  result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `call "${setup}" -no_logo -arch=x64 -host_arch=x64 && cl.exe ${args.join(' ')}`], { cwd: root, stdio: 'inherit', windowsVerbatimArguments: true })
}
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Windows helper compilation failed (${result.status})`)
const test = spawnSync(resolve(root, 'build/native/GuziWindowsHelper.exe'), ['--self-test'], { stdio: 'inherit', timeout: 15_000 })
if (test.error) throw test.error
if (test.status !== 0) throw new Error(`Windows helper self-test failed (${test.status})`)
