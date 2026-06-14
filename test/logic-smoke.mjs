// 纯函数回归测试：时间规整 normalizeTime（经 normalizeItem）+ 敏感检测 detectSensitive
// 锁住 QA 2026-06-12 报告 §4 / §12 修复，纯函数无需 API。运行：npm run test:logic
import { normalizeItem } from '../src/shared/parsing.ts'
import { detectSensitive } from '../src/main/sensitive.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- normalizeTime（QA §4）：经公开入口 normalizeItem 验证 ----
const due = (v) => normalizeItem({ title: 'x', due_time: v }).due_time

check('一位分钟补零（不再被改成 23:59）', due('2026-06-20 9:5') === '2026-06-20T09:05')
check('一位时分都补零', due('2026-6-5T9:5') === '2026-06-05T09:05')
check('缺时间部分按当天 23:59', due('2026-06-20') === '2026-06-20T23:59')
check('非法日期 6-31 整体作废', due('2026-06-31') === null)
check('非法日期 2-30 整体作废', due('2026-02-30') === null)
check('非法时间 25:99 整体作废', due('2026-06-20T25:99') === null)
check('小时越界 24:00 作废', due('2026-06-20T24:00') === null)
check('非字符串返回 null', due(123) === null)
check('乱字符串返回 null', due('下周三') === null)
check('合法整点保留', due('2026-12-31T08:00') === '2026-12-31T08:00')

// ---- normalizeItem 其它防护（QA §4 NaN / confidence）----
check('空标题返回 null', normalizeItem({ title: '   ' }) === null)
check('confidence NaN 兜底 0.3', normalizeItem({ title: 'x', confidence: NaN }).confidence === 0.3)
check('confidence 超界上钳到 1', normalizeItem({ title: 'x', confidence: 5 }).confidence === 1)
check('confidence 负值下钳到 0', normalizeItem({ title: 'x', confidence: -1 }).confidence === 0)
check('非法 item_type 回落 other', normalizeItem({ title: 'x', item_type: 'bogus' }).item_type === 'other')

// ---- detectSensitive（QA §12）----
const has = (text, tag) => detectSensitive(text).includes(tag)

check('验证码命中', has('你的验证码是 1234', '验证码'))
check('密码命中', has('登录 password: Byte@2026!', '密码'))
check('手机号命中（旧版漏报）', has('联系我 13812345678', '手机号'))
check('座机/短号不误报手机号', !has('电话 010-12345678', '手机号'))
check('合法 Luhn 银行卡命中', has('卡号 4111 1111 1111 1111', '银行卡号'))
check('非 Luhn 16 位不报银行卡', !has('编号 1234 5678 1234 5678', '银行卡号'))
check('混合分隔符不拼成银行卡', !has('1234-5678 9012-3456-7890', '银行卡号'))
check('18 位身份证命中', has('身份证 11010119900307123X', '身份证号'))
check('15 位身份证命中（旧版漏报）', has('老证号 110101900307123', '身份证号'))
check(
  '纯数字 18 位身份证不被双报为银行卡',
  (() => {
    const r = detectSensitive('公民身份号码 110101199003078018')
    return r.includes('身份证号') && !r.includes('银行卡号')
  })()
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
