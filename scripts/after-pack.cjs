const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const BRAND = '谷子助手'
const INTERNAL = 'GuziAssistant'

function setPlistString(file, key, value) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, file])
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')
  if (!fs.existsSync(frameworksPath)) return

  const mainInfo = path.join(appPath, 'Contents', 'Info.plist')
  const mainMacosPath = path.join(appPath, 'Contents', 'MacOS')
  const generatedMain = path.join(mainMacosPath, context.packager.appInfo.productFilename)
  const internalMain = path.join(mainMacosPath, INTERNAL)
  if (fs.existsSync(generatedMain) && !fs.existsSync(internalMain)) fs.renameSync(generatedMain, internalMain)
  setPlistString(mainInfo, 'CFBundleExecutable', INTERNAL)
  setPlistString(mainInfo, 'CFBundleName', INTERNAL)

  for (const entry of fs.readdirSync(frameworksPath)) {
    if (!entry.startsWith(`${BRAND} Helper`) || !entry.endsWith('.app')) continue

    const oldAppPath = path.join(frameworksPath, entry)
    const newEntry = `${INTERNAL}${entry.slice(BRAND.length)}`
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
}
