import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const packageJson = JSON.parse(read('../package.json'))
const builder = read('../electron-builder.yml')
const index = read('../src/main/index.ts')
const quickAction = read('../src/main/quickaction.ts')
const ics = read('../src/shared/ics.ts')
const afterPack = read('../scripts/after-pack.cjs')
const publish = read('../scripts/publish-release.sh')

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

check('package productName 使用谷子助手', packageJson.productName === '谷子助手')
check('builder productName 使用谷子助手', /productName:\s*谷子助手/.test(builder))
check('helper 规范化钩子已启用', /afterPack:\s*scripts\/after-pack\.cjs/.test(builder))
check('外部显示名使用谷子助手', /CFBundleDisplayName:\s*谷子助手/.test(builder))
check('主 Bundle 内部名保留 GuziAssistant', /CFBundleName:\s*GuziAssistant/.test(builder))
check('主进程可执行文件由钩子保留 GuziAssistant', /CFBundleExecutable.*GuziAssistant|INTERNAL\s*=\s*'GuziAssistant'/.test(builder + afterPack))
// GitHub Release 会把 asset 名里的非 ASCII 整段吃掉（谷子助手-0.9.0-arm64.dmg → -0.9.0-arm64.dmg），
// 所以产物名必须是 ASCII；中文品牌由 productName / CFBundleDisplayName 承担。
check('安装包文件名使用 ASCII', /artifactName:\s*['"]GuziAssistant-\$\{version\}/.test(builder))
check('发布脚本跟随安装包文件名', /GuziAssistant-\$\{VERSION\}-arm64\.dmg/.test(publish))
// 只留 identity: null 会产出没有 _CodeSignature 的包，Gatekeeper 判「已损坏」（#127）。
check('打包后补 adhoc 签名', /codesign['"],\s*\['--force',\s*'--deep',\s*'--sign',\s*'-'/.test(afterPack))
check('签完自检签名有效', /'--verify',\s*'--deep',\s*'--strict'/.test(afterPack))
check('appId 保持不变', /appId:\s*cn\.shilong\.gooz/.test(builder))
check('userData 固定到旧目录', /app\.setPath\('userData', join\(app\.getPath\('appData'\), 'GuziAssistant'\)\)/.test(index))
check('快捷操作继续使用兼容 dropbox', /Application Support\/GuziAssistant\/dropbox/.test(quickAction))
check('日历导出显示谷子助手', /PRODID:-\/\/谷子助手\/\/Task Export\/\/CN/.test(ics))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
