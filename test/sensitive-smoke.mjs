// 纯函数单测：敏感信息检测与脱敏。运行：npm run test:sensitive
import { detectSensitive, redactSensitive } from '../src/shared/sensitive.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const gone = (raw, needle) => {
  const r = redactSensitive(raw)
  return !r.text.includes(needle) && r.text.includes('[已隐去·')
}

// ---- 服务商 token（gitleaks 形态）----
check('OpenAI sk- 密钥打码', gone(`用 sk-${'Ab1'.repeat(16)} 调接口`, 'sk-Ab1'))
check('Anthropic sk-ant- 打码', gone(`key=sk-ant-api03-${'x'.repeat(30)}`, 'sk-ant'))
check('GitHub ghp_ 打码', gone(`推送用 ghp_${'a1B2'.repeat(9)} 认证`, 'ghp_'))
check('AWS AKIA 打码', gone('AKIAIOSFODNN7EXAMPLE 是访问键', 'AKIAIOSFODNN7'))
check('Slack xoxb 打码', gone('机器人 xoxb-1234567890123-abcDEF 已配置', 'xoxb-'))
check('Google AIza 打码', gone(`AIza${'Sy1'.repeat(11)}xy 泄露`, 'AIza'))
check('GitLab glpat 打码', gone(`glpat-${'wX9'.repeat(8)}`, 'glpat-'))
const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IuW8oOS4iSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c`
check('JWT 打码', gone(`Authorization: ${jwt}`, 'eyJhbGciOi'))
check('Bearer 令牌打码', gone('Bearer abcdef1234567890XYZWUV 已过期', 'abcdef1234567890'))
check(
  '私钥块打码',
  gone('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nQIDAQAB\n-----END RSA PRIVATE KEY-----', 'MIIEow')
)

// ---- 凭据关键词 + 赋值 ----
check('password= 值打码、键保留', (() => {
  const r = redactSensitive('password = hunter2abc 请勿外传')
  return !r.text.includes('hunter2abc') && r.text.includes('password')
})())
check('中文 密码：值打码', gone('登录密码：Zx98765 请查收', 'Zx98765'))
check('密码后接纯中文不误伤', redactSensitive('密码：请尽快修改并妥善保管').text === '密码：请尽快修改并妥善保管')

// ---- 验证码 ----
check('验证码数字打码', gone('您的验证码是 384756，5 分钟内有效', '384756'))
check('验证码关键词保留', redactSensitive('您的验证码是 384756').text.includes('验证码'))

// ---- 证件 / 卡号（Presidio 式校验和分层）----
check('18 位身份证打码', gone('身份证 110101199003077758 已登记', '110101199003077758'))
check('银行卡 Luhn 有效打码', gone('卡号 4111 1111 1111 1111 转账', '4111 1111'))
check('16 位 Luhn 无效不打', redactSensitive('单号 4111111111111112 已发货').text.includes('4111111111111112'))

// ---- 高熵兜底（detect-secrets 阈值）----
check('高熵 hex 打码', gone('哈希 d4e5f6a7b8c91a2b3c4d5e6f7a8b9c0d 校验', 'd4e5f6a7'))
check('低熵长串不打', redactSensitive('编号 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 正常').text.includes('aaaaaaaa'))

// ---- 不该动的东西 ----
check('手机号不打码（任务联系信息）', redactSensitive('联系张三 13800138000').text.includes('13800138000'))
check('普通中文不变', redactSensitive('明天下午 3 点开会讨论项目进展').text === '明天下午 3 点开会讨论项目进展')
check('普通 URL 不变', redactSensitive('文档在 https://github.com/openai/openai-cookbook').text.includes('openai-cookbook'))

// ---- detectSensitive 提示面 ----
const d = detectSensitive('密码是 abc123，验证码 5566，联系 13800138000')
check('detect 含密码/验证码/手机号', ['密码', '验证码', '手机号'].every((k) => d.includes(k)))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
