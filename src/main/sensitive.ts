function luhnValid(digits: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

const BIRTH = '(19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])'
const ID18_RE = new RegExp(`(?<!\\d)\\d{6}${BIRTH}\\d{3}[\\dXx](?!\\d)`, 'g')
const ID15_RE = new RegExp(`(?<!\\d)\\d{6}\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])\\d{3}(?!\\d)`, 'g')
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const CARD_CAND_RE = /(?<!\d)(?:\d[ -]?){14,18}\d(?!\d)/g

/** 文档 CAP-07：疑似敏感内容在提交前提示用户确认 */
export function detectSensitive(text: string): string[] {
  const hits: string[] = []
  if (/验证码|校验码|动态码|verification code|OTP/i.test(text)) hits.push('验证码')
  if (/密码|口令|password|passwd/i.test(text)) hits.push('密码')

  const idMatches = [...text.matchAll(ID18_RE), ...text.matchAll(ID15_RE)].map((m) => m[0])
  if (idMatches.length) hits.push('身份证号')

  for (const m of text.matchAll(CARD_CAND_RE)) {
    const raw = m[0]
    // 分隔符必须统一，避免把两个相邻的独立编号拼成一张"卡"
    const seps = new Set(raw.replace(/\d/g, ''))
    if (seps.size > 1) continue
    const digits = raw.replace(/\D/g, '')
    if (digits.length < 15 || digits.length > 19) continue
    if (idMatches.some((id) => digits.includes(id.replace(/[Xx]/, '')))) continue
    if (luhnValid(digits)) {
      hits.push('银行卡号')
      break
    }
  }

  if (PHONE_RE.test(text)) hits.push('手机号')
  return hits
}
