// FTS5 查询构建（#52）离线单测。运行：npm run test:ftsquery
import { buildFtsQuery } from '../src/shared/fts-query.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

check('单词包成短语', buildFtsQuery('周报') === '"周报"')
check('多词 AND 连接', buildFtsQuery('周报 材料') === '"周报" AND "材料"')
check('折叠多余空白', buildFtsQuery('  周报   材料  ') === '"周报" AND "材料"')
check('内部双引号转义', buildFtsQuery('a"b') === '"a""b"')
check('FTS 算子被中和为字面量', buildFtsQuery('AND OR') === '"AND" AND "OR"')
check('星号不作通配（被短语包裹）', buildFtsQuery('foo*') === '"foo*"')
check('空输入→空串', buildFtsQuery('') === '')
check('纯空白→空串', buildFtsQuery('   ') === '')
check('null/undefined 安全', buildFtsQuery(undefined) === '' && buildFtsQuery(null) === '')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
