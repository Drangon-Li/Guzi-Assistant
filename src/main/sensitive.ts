const RULES: [string, RegExp][] = [
  ['验证码', /验证码|校验码|动态码|verification code|OTP/i],
  ['密码', /密码|口令|password|passwd/i],
  ['银行卡号', /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/],
  ['身份证号', /(?<!\d)\d{17}[\dXx](?!\d)/]
]

/** 文档 CAP-07：疑似敏感内容在提交前提示用户确认 */
export function detectSensitive(text: string): string[] {
  return RULES.filter(([, re]) => re.test(text)).map(([name]) => name)
}
