const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const INTERNAL = 'GuziAssistant'

function setPlistString(file, key, value) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, file])
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')
  const brand = context.packager.appInfo.productFilename
  const update = context.packager.info.metadata.guziUpdate
  const { validateUpdateConfig } = await import('./macos-release.mjs')
  validateUpdateConfig(update)
  const internal = update.channel === 'test' ? `GuziAssistantUpdateTest-${update.appId.split('.').at(-1)}` : INTERNAL
  const sparkle = path.join(context.packager.projectDir, 'build', 'sparkle')
  if (!fs.existsSync(path.join(sparkle, 'sparkle-bridge.node'))) throw new Error('Run prepare:mac before packaging')
  execFileSync('/usr/bin/ditto', [path.join(sparkle, 'Sparkle.framework'), path.join(frameworksPath, 'Sparkle.framework')])
  const native = path.join(appPath, 'Contents', 'Resources', 'native')
  fs.mkdirSync(native, { recursive: true })
  fs.copyFileSync(path.join(sparkle, 'sparkle-bridge.node'), path.join(native, 'sparkle-bridge.node'))
  const licenses = path.join(appPath, 'Contents', 'Resources', 'licenses')
  fs.mkdirSync(licenses, { recursive: true })
  fs.copyFileSync(path.join(sparkle, 'LICENSE'), path.join(licenses, 'Sparkle-LICENSE.txt'))

  const mainInfo = path.join(appPath, 'Contents', 'Info.plist')
  const mainMacosPath = path.join(appPath, 'Contents', 'MacOS')
  const generatedMain = path.join(mainMacosPath, context.packager.appInfo.productFilename)
  const internalMain = path.join(mainMacosPath, internal)
  if (fs.existsSync(generatedMain) && !fs.existsSync(internalMain)) fs.renameSync(generatedMain, internalMain)
  setPlistString(mainInfo, 'CFBundleExecutable', internal)
  setPlistString(mainInfo, 'CFBundleName', internal)
  setPlistString(mainInfo, 'SUFeedURL', update.feedUrl)
  setPlistString(mainInfo, 'SUPublicEDKey', update.publicKey)
  for (const key of ['SUAutomaticallyUpdate', 'SUAllowsAutomaticUpdates', 'SUEnableAutomaticChecks']) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-bool', 'false', mainInfo])
  }
  execFileSync('/usr/bin/plutil', ['-replace', 'SUVerifyUpdateBeforeExtraction', '-bool', 'true', mainInfo])

  for (const entry of fs.readdirSync(frameworksPath)) {
    if (!entry.startsWith(`${brand} Helper`) || !entry.endsWith('.app')) continue

    const oldAppPath = path.join(frameworksPath, entry)
    const newEntry = `${internal}${entry.slice(brand.length)}`
    const newAppPath = path.join(frameworksPath, newEntry)
    if (!fs.existsSync(newAppPath)) fs.renameSync(oldAppPath, newAppPath)

    const oldExecutable = entry.slice(0, -'.app'.length)
    const newExecutable = newEntry.slice(0, -'.app'.length)
    const macosPath = path.join(newAppPath, 'Contents', 'MacOS')
    const oldExecutablePath = path.join(macosPath, oldExecutable)
    const newExecutablePath = path.join(macosPath, newExecutable)
    if (fs.existsSync(oldExecutablePath) && !fs.existsSync(newExecutablePath)) {
      fs.renameSync(oldExecutablePath, newExecutablePath)
    }

    const helperInfo = path.join(newAppPath, 'Contents', 'Info.plist')
    if (fs.existsSync(helperInfo)) setPlistString(helperInfo, 'CFBundleExecutable', newExecutable)
  }

  // identity: null skips signing, so seal the bundle after renames and plist edits.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
