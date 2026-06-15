/**
 * 收付款（chpay / 彩虹易支付 V2）签名核心 —— #41 收款闭环的可复用、架构无关核心。
 *
 * ⚠️ 仅服务端使用：本模块用商户私钥签名，**绝不能打进客户端**（故放 server/，不进 electron-vite 打包）。
 * 算法照搬已 LIVE 验证的参考实现（见 /root/capabilities/chpay-payment/）：SHA256WithRSA。
 * 三大坑（照抄）：① 严格 ASCII 升序，别用 localeCompare；② 非空判定 `null||trim===''`，值 '0' 保留；
 * ③ 待签串原始值直接拼、不做 URL 编码。回调金额可能返 '1' 而非 '1.00'，用数值比较。
 */
import crypto from 'node:crypto'

/** 后台给的是纯 base64（无 PEM header）→ 拼成 PEM；已是 PEM 则原样返回。 */
export function toPemFormat(key: string, type: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  if (key.includes('-----BEGIN')) return key
  const cleanKey = key.replace(/\s/g, '')
  const formatted = cleanKey.match(/.{1,64}/g)?.join('\n') ?? cleanKey
  return `-----BEGIN ${type}-----\n${formatted}\n-----END ${type}-----`
}

/** 待签名串：去空值/sign/sign_type → 严格 ASCII 升序 → a=b&c=d（不 URL 编码；值 '0' 保留）。 */
export function buildSignBase(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([k, v]) => v != null && v.trim() !== '' && k !== 'sign' && k !== 'sign_type')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

/** 用商户私钥签名，返回 base64。privateKey 可为纯 base64 或 PEM。 */
export function signParams(params: Record<string, string>, privateKey: string): string {
  const s = crypto.createSign('RSA-SHA256')
  s.update(buildSignBase(params))
  s.end()
  return s.sign(toPemFormat(privateKey, 'PRIVATE KEY'), 'base64')
}

/** 用平台公钥验签（回调用）。缺 sign 或异常一律返 false。 */
export function verifyParams(params: Record<string, string>, publicKey: string): boolean {
  const received = params.sign
  if (!received) return false
  try {
    const v = crypto.createVerify('RSA-SHA256')
    v.update(buildSignBase(params))
    v.end()
    return v.verify(toPemFormat(publicKey, 'PUBLIC KEY'), received, 'base64')
  } catch {
    return false
  }
}

/** 回调金额校验：内部「分」与平台返回的「元」字符串数值比较（'1' vs '1.00' 都通过）。 */
export function amountMatchesYuan(expectedCents: number, moneyYuan: string): boolean {
  return Math.abs(expectedCents / 100 - parseFloat(moneyYuan)) <= 0.001
}

/** 生成内部订单号（自定义，时间戳+随机）。 */
export function generateOutTradeNo(rand: string, ts: number): string {
  return `E${ts}${rand}`.toUpperCase()
}

export interface CreateOrderInput {
  pid: string
  payType: 'alipay' | 'wxpay'
  outTradeNo: string
  amountCents: number
  notifyUrl: string
  returnUrl: string
  name: string
  timestampSec: number
}

/** 构建「统一下单」表单参数（含签名）。返回提交给 chpay 网关的 params。 */
export function buildCreateOrderParams(
  input: CreateOrderInput,
  privateKey: string
): Record<string, string> {
  const params: Record<string, string> = {
    pid: input.pid,
    type: input.payType,
    out_trade_no: input.outTradeNo,
    notify_url: input.notifyUrl,
    return_url: input.returnUrl,
    name: input.name,
    money: (input.amountCents / 100).toFixed(2),
    timestamp: String(input.timestampSec)
  }
  params.sign = signParams(params, privateKey)
  params.sign_type = 'RSA'
  return params
}
