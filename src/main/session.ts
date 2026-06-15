/**
 * 主进程缓存的登录会话（#70）。会话在 renderer（supabase-js）持有，auth 变化时经 IPC
 * `auth:set-session` 推给主进程，供 parser 调 parse 网关时带 Authorization。
 */
let functionsBase = ''
let token: string | null = null

export function setSession(s: { functionsBase: string; token: string | null }): void {
  functionsBase = s.functionsBase || ''
  token = s.token
}

export function getSession(): { functionsBase: string; token: string | null } {
  return { functionsBase, token }
}
