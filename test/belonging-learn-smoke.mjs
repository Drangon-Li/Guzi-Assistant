// 归属个性化学习（#15）离线单测。运行：npm run test:belonglearn
import {
  extractBelongingSignals,
  mergeBelongingNotMine,
  learnNotMine
} from '../src/shared/belonging-learn.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 提取
check('@提及', eq(extractBelongingSignals('提醒 @张三 交报告', []), ['张三']))
check('引号内名字（中文引号）', eq(extractBelongingSignals('这是「李四」的任务', []), ['李四']))
check('英文引号', eq(extractBelongingSignals("send to 'Bob' please", []), ['Bob']))
check('排除自己的名字/昵称', eq(extractBelongingSignals('@小明 @张三', ['小明']), ['张三']))
check('去重', eq(extractBelongingSignals('@张三 又 @张三', []), ['张三']))
check('无高精度信号→空', eq(extractBelongingSignals('提醒张三交报告', []), []))
check('过长 token 丢弃', eq(extractBelongingSignals('@' + 'x'.repeat(30), []), []))
check('空文本→空', eq(extractBelongingSignals('', ['x']), []))

// 合并
check('合并去重（忽略大小写、保留首次）', eq(mergeBelongingNotMine(['Bob'], ['bob', 'Alice']), ['Bob', 'Alice']))
check('上限保留最新', eq(mergeBelongingNotMine(['a', 'b', 'c'], ['d'], 2), ['c', 'd']))
check('空白条目剔除', eq(mergeBelongingNotMine(['  ', 'a'], ['']), ['a']))

// 学习闭环
const profile = { name: '小明', nicknames: ['明明'], accounts: [], belongingNotMine: ['老王'] }
const after = learnNotMine(profile, '请「张三」准备材料')
check('学习：并入新信号', eq(after.belongingNotMine, ['老王', '张三']))
check('学习：不可变（返回新对象）', after !== profile)
check('学习：排除自己昵称后无信号→原样返回', learnNotMine(profile, '@明明 记得开会') === profile)
check('学习：原 profile 未被改', eq(profile.belongingNotMine, ['老王']))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
