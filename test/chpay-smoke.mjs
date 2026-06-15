// chpay 收款签名核心离线单测（#41）。运行：npm run test:chpay
// 用现生成的 RSA 密钥对做 sign→verify 闭环，无需真商户、不碰网络/真钱。
import crypto from 'node:crypto'
import {
  toPemFormat,
  buildSignBase,
  signParams,
  verifyParams,
  amountMatchesYuan,
  buildCreateOrderParams
} from '../server/chpay/sign.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const kp = () =>
  crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
const { publicKey, privateKey } = kp()

const base = {
  pid: '1007', type: 'alipay', out_trade_no: 'E1', money: '1.00',
  timestamp: '1700000000', name: 'eshell', zero: '0', empty: '', blank: '   '
}

// 待签串
check('键严格 ASCII 升序', buildSignBase({ c: '3', a: '1', b: '2' }) === 'a=1&b=2&c=3')
check("值 '0' 保留", buildSignBase(base).includes('zero=0'))
check('空/纯空白丢弃', !buildSignBase(base).includes('empty=') && !buildSignBase(base).includes('blank='))
check('不做 URL 编码（空格原样）', buildSignBase({ a: 'x y' }) === 'a=x y')
check('忽略 sign/sign_type', buildSignBase({ ...base, sign: 'X', sign_type: 'RSA' }) === buildSignBase(base))

// 签名 / 验签闭环
const signed = { ...base }
signed.sign = signParams(signed, privateKey)
signed.sign_type = 'RSA'
check('合法签名验真', verifyParams(signed, publicKey))
check('改金额→验假', !verifyParams({ ...signed, money: '9.99' }, publicKey))
check('缺 sign→验假', !verifyParams({ ...base }, publicKey))
check('换错公钥→验假', !verifyParams(signed, kp().publicKey))

// PEM 包装
check('裸 base64 包成 PEM', toPemFormat('MIIBabc', 'PUBLIC KEY').startsWith('-----BEGIN PUBLIC KEY-----'))
check('已是 PEM 原样', toPemFormat('-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----', 'PUBLIC KEY').split('BEGIN').length === 2)

// 金额校验（'1' vs '1.00'）
check("100 分 vs '1' 通过", amountMatchesYuan(100, '1'))
check("100 分 vs '1.00' 通过", amountMatchesYuan(100, '1.00'))
check('金额不符→假', !amountMatchesYuan(100, '2.00'))

// 下单参数（含自签名，可被对应公钥验真）
const order = buildCreateOrderParams(
  { pid: '1007', payType: 'wxpay', outTradeNo: 'E2', amountCents: 1980, notifyUrl: 'https://x/n', returnUrl: 'https://x/r', name: 'eshell', timestampSec: 1700000000 },
  privateKey
)
check('下单 money = 元两位小数', order.money === '19.80')
check('下单 sign_type=RSA', order.sign_type === 'RSA')
check('下单参数自验真', verifyParams(order, publicKey))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
