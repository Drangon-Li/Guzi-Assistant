const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const BRAND = '谷子助手'
const INTERNAL = 'GuziAssistant'

function setPlistString(file, key, value) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, file])
}

// electron-builder 的 mac.identity: null 只会打一行「skipped macOS code signing」就走人
// （26.15.3 MacTargetHelper.handleNullIdentity），不做任何兜底签名；而上面这些重命名又动过
// bundle 内容。两者叠加的结果是：包里只剩链接器盖在可执行文件上的 adhoc 签名，却没有
// Contents/_CodeSignature —— 签名声明「我应当带资源签名」，包里却没有，Gatekeeper 判定签名损坏，
// 用户看到的提示是「已损坏，应该移到废纸篓」（#127），比「无法验证开发者」吓人得多，
// 而且这一档连 Finder 右键「打开」都救不回来。
// 这里把整个 bundle 完整 adhoc 签一遍，把提示拉回可放行的那一档。双击零提示仍然需要
// Developer ID 证书 + 公证，adhoc 只是拿到证书之前的缓解。
// 时序：afterPack 早于 electron-builder 自己的签名步骤，将来配上真证书会覆盖这份 adhoc 签名。
function adhocSign(appPath) {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  // 签完立刻验。签名与 bundle 内容对不上（例如以后有人在 afterPack 之后又改了包里的文件）
  // 会当场让构建失败，而不是等用户下载安装后才发现打不开。
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
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

  // 必须在所有重命名和 plist 改写之后：签名封的是签的那一刻的 bundle 内容。
  adhocSign(appPath)
}
