/**
 * Supabase 客户端（#69 账号体系 / 数据库即后端架构）。
 * URL + anon(publishable) key 是可公开值，构建时由 env 注入（VITE_ESHELL_SUPABASE_*）。
 * 未配置则 supabase=null、hasBackend=false：账号 / 托管解析不可用，但本地功能(屏幕监控/日程)仍可用。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_ESHELL_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_ESHELL_SUPABASE_ANON_KEY as string | undefined

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
