import { shouldUpgradeQuickAction } from '../src/shared/quickaction-migration.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

check('从未安装不主动新增', !shouldUpgradeQuickAction(false, false, false))
check('Gooz 同名旧路径需要升级', shouldUpgradeQuickAction(true, false, false))
check('仅纸壳旧 workflow 需要迁移', shouldUpgradeQuickAction(false, false, true))
check('当前 workflow 正常时不重写', !shouldUpgradeQuickAction(true, true, false))
check('当前正常但纸壳旧项残留时清理', shouldUpgradeQuickAction(true, true, true))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
