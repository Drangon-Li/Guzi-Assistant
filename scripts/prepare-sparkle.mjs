import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const sparkleOutput = join(root, 'build/sparkle')
export const sparkleRelease = JSON.parse(await readFile(new URL('./sparkle-release.json', import.meta.url), 'utf8'))

const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', ...options })
async function exists(path) { return access(path).then(() => true, () => false) }

export async function locateNodeHeaders(explicit = process.env.NODE_INCLUDE_DIR) {
  // The package version, not dist/version: since Electron 42 the binary is only downloaded on first use.
  const electronVersion = JSON.parse(await readFile(join(root, 'node_modules/electron/package.json'), 'utf8').catch(() => '{}')).version || ''
  const nodePrefix = dirname(dirname(await realpath(process.execPath)))
  const candidates = [
    explicit && resolve(explicit),
    join(nodePrefix, 'include/node'),
    process.config.variables.node_prefix && join(process.config.variables.node_prefix, 'include/node'),
    electronVersion && join(homedir(), 'Library/Caches/electron-gyp', electronVersion, 'include/node'),
    electronVersion && join(homedir(), '.electron-gyp', electronVersion, 'include/node'),
    join(homedir(), 'Library/Caches/node-gyp', process.versions.node, 'include/node'),
    join(homedir(), '.cache/node-gyp', process.versions.node, 'include/node')
  ].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (await exists(join(candidate, 'node_api.h')) && await exists(join(candidate, 'js_native_api.h'))) return candidate
  }
  throw new Error(`Node-API headers not found. Set NODE_INCLUDE_DIR to an include/node directory. Checked: ${candidates.join(', ')}`)
}

export async function prepareSparkle({ archive, headers } = {}) {
  if (process.platform !== 'darwin') throw new Error('Sparkle preparation requires macOS and Command Line Tools')
  const include = await locateNodeHeaders(headers)
  const build = join(root, 'build')
  await mkdir(build, { recursive: true })
  const staging = await mkdtemp(join(build, '.sparkle-'))
  try {
    const filename = `Sparkle-${sparkleRelease.version}.tar.xz`
    const cached = join(sparkleOutput, filename)
    const archivePath = join(staging, filename)
    if (archive || await exists(cached)) await copyFile(archive ? resolve(archive) : cached, archivePath)
    else {
      console.log(`Downloading Sparkle ${sparkleRelease.version} from its official release`)
      const response = await fetch(sparkleRelease.url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`Sparkle download failed: HTTP ${response.status}`)
      await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
    }
    const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex')
    if (digest !== sparkleRelease.sha256) throw new Error(`Sparkle archive SHA256 mismatch: expected ${sparkleRelease.sha256}, received ${digest}`)
    const extracted = join(staging, 'extracted')
    await mkdir(extracted)
    run('/usr/bin/tar', ['-xf', archivePath, '-C', extracted])
    const output = join(staging, 'output')
    await mkdir(output)
    run('/usr/bin/ditto', [join(extracted, 'Sparkle.framework'), join(output, 'Sparkle.framework')])
    run('/usr/bin/ditto', [join(extracted, 'bin'), join(output, 'bin')])
    await copyFile(join(extracted, 'LICENSE'), join(output, 'LICENSE'))
    await copyFile(archivePath, join(output, filename))
    const compiler = execFileSync('/usr/bin/xcrun', ['--find', 'clang++'], { encoding: 'utf8' }).trim()
    const sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()
    run(compiler, [
      '-std=c++17', '-fobjc-arc', '-fblocks', '-arch', sparkleRelease.architecture,
      '-isysroot', sdk,
      `-mmacosx-version-min=${sparkleRelease.minimumMacOS}`, '-bundle', '-undefined', 'dynamic_lookup',
      '-I', include, '-F', output, '-framework', 'Cocoa', '-framework', 'Sparkle',
      '-Wl,-rpath,@executable_path/../Frameworks',
      join(root, 'src/main/native/sparkle-bridge.mm'), '-o', join(output, 'sparkle-bridge.node')
    ])
    await writeFile(join(output, 'release.json'), `${JSON.stringify({ ...sparkleRelease, nodeApi: 8 }, null, 2)}\n`)
    await rm(sparkleOutput, { recursive: true, force: true })
    await rename(output, sparkleOutput)
    console.log(`Prepared Sparkle ${sparkleRelease.version}: ${sparkleOutput} (Node-API headers: ${include})`)
    return sparkleOutput
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i]
    if (!['--archive', '--headers'].includes(argument) || !process.argv[i + 1]) throw new Error('Usage: node scripts/prepare-sparkle.mjs [--archive official.tar.xz] [--headers include/node]')
    options[argument.slice(2)] = process.argv[++i]
  }
  await prepareSparkle(options)
}
