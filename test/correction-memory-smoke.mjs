// 纯函数单测：correction-memory（trigram 相似度 / 精确命中 / 相似检索 / few-shot 构造）。
// 运行：node test/correction-memory-smoke.mjs
import {
  textSimilarity,
  exactCorrection,
  relevantCorrections,
  buildCorrectionFewShot
} from '../src/shared/correction-memory.ts'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) pass++
  else {
    fail++
    console.error('FAIL:', name)
  }
}

// ---- textSimilarity ----
check('相同文本 sim=1', textSimilarity('明天下午三点开会', '明天下午三点开会') === 1)
check('完全不同 sim≈0', textSimilarity('明天开会', '股票基金理财') < 0.1)
const sPart = textSimilarity('明天下午三点之前完成报告', '明天下午三点之前完成方案')
check('部分相似介于 0~1', sPart > 0.3 && sPart < 1)

// ---- exactCorrection / relevantCorrections ----
const corr = [
  { inputText: '明天下午三点之前完成公司注册', isTodo: true, title: '完成公司注册', belongs: 'yes' },
  { inputText: '帮我点个外卖', isTodo: false, title: null, belongs: null }
]
check('近似输入精确命中', exactCorrection('明天下午三点之前完成公司注册的事', corr, 0.6)?.title === '完成公司注册')
check('无关输入无命中', exactCorrection('完全无关的内容xyz', corr) === null)
check('相似检索取到相关条', relevantCorrections('明天下午三点之前完成公司的注册', corr, 2, 0.2).length >= 1)
check('相似检索过滤无关', relevantCorrections('随便聊聊天气', corr, 2, 0.3).length === 0)

// ---- buildCorrectionFewShot ----
check('todo→JSON 示例', buildCorrectionFewShot([corr[0]]).includes('"title":"完成公司注册"'))
check('非 todo→[] 示例', buildCorrectionFewShot([corr[1]]).includes('→ []'))

console.log(`correction-memory-smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
