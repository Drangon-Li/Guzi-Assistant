/**
 * Supabase 客户端（#69 账号体系 / 数据库即后端架构）。
 * URL + publishable key 是设计上可公开的客户端值（数据由 RLS 保护），故内置我方托管后端默认值，
 * 注册登录即用、零配置；自建后端用 VITE_GUZI_ASSISTANT_SUPABASE_* 覆盖。
 * 旧 VITE_ESHELL_SUPABASE_* 仅作升级兼容回退。
 * 两者皆空才 supabase=null、hasBackend=false（账号/托管解析不可用，本地功能仍可用）。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { firstNonBlank } from '@shared/env-value'

// 我方托管后端（project rtgypddrknuylecqejmp）。publishable key 安全暴露于客户端。
const DEFAULT_URL = 'https://rtgypddrknuylecqejmp.supabase.co'
const DEFAULT_ANON_KEY = 'sb_publishable_KBP637mcafctZX9LczEK3w_S--3WBEq'

const url =
  firstNonBlank(
    import.meta.env.VITE_GUZI_ASSISTANT_SUPABASE_URL as string | undefined,
    import.meta.env.VITE_ESHELL_SUPABASE_URL as string | undefined
  ) ||
  DEFAULT_URL
const anonKey =
  firstNonBlank(
    import.meta.env.VITE_GUZI_ASSISTANT_SUPABASE_ANON_KEY as string | undefined,
    import.meta.env.VITE_ESHELL_SUPABASE_ANON_KEY as string | undefined
  ) ||
  DEFAULT_ANON_KEY

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
