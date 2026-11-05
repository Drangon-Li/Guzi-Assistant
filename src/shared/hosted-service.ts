// 托管服务开关：账号登录、托管解析网关、积分/订阅/收款、应用内反馈，都依赖维护者运营的 Supabase 后端。
//
// 当前关闭（本地模式）：托管后端暂停期间，谷子助手完全在本机运行——数据只存本机，
// 解析、屏幕感知与助手对话都使用用户在「设置 → 助手 → 模型」里配置的 API。
// 恢复托管服务时把 HOSTED_SERVICE_ENABLED 改回 true 即可；服务端代码（supabase/functions、server/）原样保留。
//
// 自建后端不受这个开关影响：构建时设置 VITE_GUZI_ASSISTANT_SUPABASE_URL / _ANON_KEY 照常启用账号体系。

export const HOSTED_SERVICE_ENABLED = false

/** 维护者托管的 Supabase 项目。URL 与 publishable key 本就是可公开的客户端值（数据由 RLS 保护）。 */
export const HOSTED_BACKEND = {
  url: 'https://rtgypddrknuylecqejmp.supabase.co',
  anonKey: 'sb_publishable_KBP637mcafctZX9LczEK3w_S--3WBEq'
} as const

/** 客户端实际连接的后端：构建时覆盖优先；否则只有托管服务开启时才回落到维护者的托管后端。 */
export function resolveBackend(
  override: { url?: string; anonKey?: string },
  hostedEnabled: boolean = HOSTED_SERVICE_ENABLED
): { url: string; anonKey: string } {
  return {
    url: override.url || (hostedEnabled ? HOSTED_BACKEND.url : ''),
    anonKey: override.anonKey || (hostedEnabled ? HOSTED_BACKEND.anonKey : '')
  }
}
