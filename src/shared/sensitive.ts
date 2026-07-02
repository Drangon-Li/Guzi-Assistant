// 敏感信息检测与脱敏（上云前的最后一道隐私门）。
// 模式设计参考社区标准做法：
// - gitleaks：服务商 token 固定形态正则（sk-/ghp_/AKIA/xox/AIza/glpat/JWT）、
//   凭据关键词+赋值通用规则、PEM 私钥块
// - detect-secrets：高熵字符串兜底（base64 字符集熵 ≥4.5、hex ≥3.0）抓无标签裸密钥
// - Presidio：正则 + 校验和分层压误报（银行卡 Luhn、身份证生日段结构校验）
// 手机号/邮箱不打码：它们常是任务的必要信息（联系人），敏感度低；只在提交提示里出现。

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

/** Shannon 熵（bits/char）；detect-secrets 用它识别"看起来随机"的裸密钥 */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let e = 0
  for (const n of freq.values()) {
    const p = n / s.length
    e -= p * Math.log2(p)
  }
  return e
}

const BIRTH = '(19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])'
const ID18_RE = new RegExp(`(?<!\\d)\\d{6}${BIRTH}\\d{3}[\\dXx](?!\\d)`, 'g')
const ID15_RE = /(?<!\d)\d{6}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const CARD_CAND_RE = /(?<!\d)(?:\d[ -]?){14,18}\d(?!\d)/g

// 服务商 token 固定形态（取自 gitleaks 规则库的模式骨架，长度略放宽以容忍 OCR 截断）
const TOKEN_RES: [RegExp, string][] = [
  [
    /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,10000}?(?:-----END[ A-Z0-9_-]{0,100}KEY(?: BLOCK)?-----|$)/g,
    '私钥'
  ],
  [/(?<![\w-])sk-[A-Za-z0-9_-]{20,}(?![\w-])/g, 'API密钥'], // OpenAI / Anthropic(sk-ant-…)
  [/(?<![\w-])gh[pousr]_[A-Za-z0-9]{36,255}(?![\w-])/g, 'API密钥'], // GitHub PAT/OAuth/App
  [/(?<![\w-])(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}(?![\w-])/g, 'API密钥'], // AWS
  [/(?<![\w-])xox[bpaes]-[A-Za-z0-9-]{10,}(?![\w-])/g, 'API密钥'], // Slack
  [/(?<![\w-])AIza[\w-]{35}(?![\w-])/g, 'API密钥'], // Google
  [/(?<![\w-])glpat-[\w-]{20,}(?![\w-])/g, 'API密钥'], // GitLab
  [/(?<![\w-])ey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9/_-]{17,}\.[A-Za-z0-9/_=-]{10,}(?![\w-])/g, 'JWT令牌'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, '令牌']
]

// 凭据关键词 + 赋值：只打码值（gitleaks generic-api-key / detect-secrets KeywordDetector 思路）
const KV_RE =
  /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b|密码|口令|密钥|令牌)(\s*[:：=＝]\s*)([^\s，。;；、]{4,})/gi
const OTP_RE = /(验证码|校验码|动态码|verification code|OTP)([^0-9\n]{0,8})(\d{4,8})/gi

// 高熵裸串兜底（detect-secrets 默认阈值）；哈希/commit SHA 被误伤对待办场景无害
const RAND_RUN_RE = /(?<![\w+/=-])[A-Za-z0-9+/=_-]{32,}(?![\w+/=-])/g

const mask = (label: string): string => `[已隐去·${label}]`

export interface RedactResult {
  /** 打码后的文本（可安全上云） */
  text: string
  /** 命中的敏感类型标签（去重） */
  hits: string[]
}

/** 上云前脱敏：把凭据/证件/卡号等敏感**值**替换成占位符，保留上下文供解析。 */
export function redactSensitive(input: string): RedactResult {
  const hits = new Set<string>()
  let text = input

  for (const [re, label] of TOKEN_RES) {
    text = text.replace(re, () => {
      hits.add(label)
      return mask(label)
    })
  }

  text = text.replace(KV_RE, (m, key: string, sep: string, value: string) => {
    if (!/[A-Za-z0-9]/.test(value)) return m // 纯中文"值"多为普通语句（如"密码：请尽快修改"），不打
    hits.add('凭据')
    return `${key}${sep}${mask('凭据')}`
  })

  text = text.replace(OTP_RE, (_m, key: string, sep: string) => {
    hits.add('验证码')
    return `${key}${sep}${mask('验证码')}`
  })

  for (const re of [ID18_RE, ID15_RE]) {
    text = text.replace(re, () => {
      hits.add('身份证号')
      return mask('身份证号')
    })
  }

  // 银行卡：候选 → 分隔符统一 → 长度 → Luhn 校验（Presidio 式 pattern+checksum）
  text = text.replace(CARD_CAND_RE, (raw) => {
    const seps = new Set(raw.replace(/\d/g, ''))
    if (seps.size > 1) return raw // 分隔符不统一：多半是两个相邻编号被拼在一起
    const digits = raw.replace(/\D/g, '')
    if (digits.length < 15 || digits.length > 19) return raw
    if (!luhnValid(digits)) return raw
    hits.add('银行卡号')
    return mask('银行卡号')
  })

  text = text.replace(RAND_RUN_RE, (run) => {
    const isHex = /^[0-9a-fA-F]+$/.test(run)
    const limit = isHex ? 3.0 : 4.5
    if (shannonEntropy(run) < limit) return run
    hits.add('高熵串')
    return mask('高熵串')
  })

  return { text, hits: [...hits] }
}

/** 文档 CAP-07：疑似敏感内容在提交前提示用户确认（检测面比脱敏更宽：含关键词与手机号）。 */
export function detectSensitive(text: string): string[] {
  const hits = new Set<string>(redactSensitive(text).hits)
  if (/验证码|校验码|动态码|verification code|OTP/i.test(text)) hits.add('验证码')
  if (/密码|口令|password|passwd/i.test(text)) hits.add('密码')
  if (PHONE_RE.test(text)) hits.add('手机号')
  return [...hits]
}
