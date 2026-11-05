/**
 * Supabase 客户端（#69 账号体系 / 数据库即后端架构）。
 * 连哪个后端由 @shared/hosted-service 决定：托管服务开启时回落到维护者的托管后端；
 * 当前是本地模式，只有构建时用 VITE_GUZI_ASSISTANT_SUPABASE_* 指定自建后端才会连。
 * 旧 VITE_ESHELL_SUPABASE_* 仅作升级兼容回退。
 * 两者皆空则 supabase=null、hasBackend=false：账号/托管解析不可用，解析走用户自己配置的模型。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { firstNonBlank } from '@shared/env-value'
import { resolveBackend } from '@shared/hosted-service'

const { url, anonKey } = resolveBackend({
  url: firstNonBlank(
    import.meta.env.VITE_GUZI_ASSISTANT_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_ESHELL_SUPABASE_URL as string | undefined
  ),
  anonKey: firstNonBlank(
    import.meta.env.VITE_GUZI_ASSISTANT_SUPABASE_ANON_KEY as string | undefined,
    import.meta.env.VITE_ESHELL_SUPABASE_ANON_KEY as string | undefined
  )
})

/** 托管后端是否已配置（决定是否显示账号/充值入口） */
export const hasBackend = Boolean(url && anonKey)

export const supabase: SupabaseClient | null = hasBackend ? createClient(url!, anonKey!) : null

/** 调 Edge Function 用的 base（functions/v1）；未配置返空串 */
export function functionsBase(): string {
  return url ? `${url.replace(/\/$/, '')}/functions/v1` : ''
}

/** 当前会话的 access token（调 Edge Function 带 Authorization）；未登录返 null */
export async function accessToken(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/**
 * 调 Edge Function：自动带 apikey + 登录 token。path 形如 `/pay-create`、`/pay-query?out_trade_no=x`。
 * 解析 JSON；非 2xx 抛 Error（取后端 error 文案）。未登录抛「请先登录」。
 */
export async function callFunction<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken()
  if (!token) throw new Error('请先登录')
  const res = await fetch(`${functionsBase()}${path}`, {
    ...init,
    headers: {
      apikey: anonKey!,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new Error(body?.error || `服务返回 ${res.status}`)
  return body as T
}
