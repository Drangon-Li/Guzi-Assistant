/**
 * 充值支付窗口（#71 / #41 收款）。
 * chpay 统一下单返回的是「表单 POST 跳转」参数（pay_url + pay_params），浏览器 GET 会因编码导致
 * 验签失败（见 chpay 文档），故必须 POST。这里开一个独立 BrowserWindow，载入一个自动提交的隐藏
 * 表单 → POST 到 chpay 网关 → 展示支付宝/微信支付页（桌面端扫码支付）。
 * 渲染层轮询 pay-query 拿到 paid 后调 payment:close 关窗。
 */
import { BrowserWindow } from 'electron'

let payWin: BrowserWindow | null = null

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** 打开支付窗口：自动提交表单 POST 到 chpay。重复调用先关旧窗。 */
export function openPayment(payUrl: string, params: Record<string, string>): void {
  closePayment()
  const fields = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
    .join('')
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>充值支付</title></head>
<body onload="document.forms[0].submit()" style="font-family:-apple-system,sans-serif;padding:48px;color:#666;text-align:center">
正在跳转到支付页…
<form method="POST" action="${escapeHtml(payUrl)}">${fields}</form>
</body></html>`
  payWin = new BrowserWindow({
    width: 460,
    height: 640,
    title: '充值支付',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  payWin.on('closed', () => {
    payWin = null
  })
  void payWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

/** 关闭支付窗口（支付成功 / 用户取消时）。 */
export function closePayment(): void {
  if (payWin && !payWin.isDestroyed()) payWin.close()
  payWin = null
}
