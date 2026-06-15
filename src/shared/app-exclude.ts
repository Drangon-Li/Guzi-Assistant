/**
 * 持续屏幕监控（#40）的隐私门：当前台 App 在用户的排除名单内时，连截图都不做。
 * 纯函数，主进程把「当前前台 App 名」与「名单」喂进来判断；前台检测见 main/frontapp.ts。
 *
 * 匹配规则：大小写不敏感、去空白、子串命中（前台名包含名单项）。
 * 子串便于「Google Chrome」被「chrome」命中；中英文名各异（微信 / WeChat）则让用户两个都填。
 */
export function isAppExcluded(
  frontApp: string | null | undefined,
  excluded: string[]
): boolean {
  if (!frontApp) return false
  const f = frontApp.trim().toLowerCase()
  if (!f) return false
  return excluded.some((e) => {
    const x = e.trim().toLowerCase()
    return x !== '' && (f === x || f.includes(x))
  })
}
