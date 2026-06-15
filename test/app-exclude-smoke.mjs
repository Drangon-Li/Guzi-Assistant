// 排除名单匹配（#40 隐私门）离线单测。运行：npm run test:appexclude
import { isAppExcluded } from '../src/shared/app-exclude.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const list = ['1Password', '微信', 'Bank']

check('精确命中', isAppExcluded('1Password', list))
check('大小写不敏感', isAppExcluded('1password', list))
check('去空白', isAppExcluded('  1Password  ', list))
check('子串：前台名含名单项', isAppExcluded('Google Chrome', ['chrome']))
check('中文 App 名命中', isAppExcluded('微信', list))
check('未命中→false', !isAppExcluded('Safari', list))
check('前台为 null→false（fail-open，不阻断监控）', !isAppExcluded(null, list))
check('前台为空串→false', !isAppExcluded('   ', list))
check('空名单→false', !isAppExcluded('1Password', []))
check('名单项空白被忽略', !isAppExcluded('Safari', ['', '  ']))
check('名单项含空白仍能命中', isAppExcluded('1Password', [' 1password ']))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
