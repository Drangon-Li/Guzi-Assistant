import { firstNonBlank } from '../src/shared/env-value.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

check('优先使用新变量', firstNonBlank('new', 'legacy') === 'new')
check('新变量为空时回退旧变量', firstNonBlank('', 'legacy') === 'legacy')
check('新变量纯空白时回退旧变量', firstNonBlank('   ', 'legacy') === 'legacy')
check('忽略 null/undefined', firstNonBlank(undefined, null, 'value') === 'value')
check('所有值为空返回空串', firstNonBlank('', '  ', undefined) === '')
check('返回值去除首尾空白', firstNonBlank('  value  ') === 'value')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
