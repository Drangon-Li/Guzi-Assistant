import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  const helper = resolve('build/native/GuziWindowsHelper.exe')
  const result = JSON.parse(execFileSync(helper, ['--self-test'], { encoding: 'utf8', timeout: 10000, windowsHide: true }))
  assert.equal(result.ok, true)
  assert.equal(result.protocol, 1)
} else {
  const directory = mkdtempSync(join(tmpdir(), 'guzi-native-protocol-'))
  try {
    const header = fileURLToPath(new URL('../src/main/native/windows/protocol.h', import.meta.url))
    const source = join(directory, 'test.cpp')
    const binary = join(directory, 'protocol-test')
    writeFileSync(source, `#include ${JSON.stringify(header)}\nint main() { guzi::selfTest(); }\n`)
    execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', source, '-o', binary], { timeout: 30000, stdio: 'pipe' })
    execFileSync(binary, [], { timeout: 10000, stdio: 'pipe' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
console.log('✓ Native Windows protocol: path identities, host-only output, privacy markers, local calendar detection, title/JSON escaping')
