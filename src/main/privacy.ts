// 前台上下文的隐私判定：本应用识别 + 排除名单/私密浏览/安全输入门。
// 屏幕感知（screenwatch）、应用采样（usage-sampler）、History collector 共用。
import { app } from 'electron'
import { getSettings } from './db'
import { decideHistoryPrivacy } from './history/privacy-policy.ts'

/** 是否谷子助手自己在前台：停在本应用页面时不该扫描自己的窗口（否则把已有日程当成新检测）。 */
export function isOwnApp(frontApp: string | null): boolean {
  if (!frontApp) return false
  const f = frontApp.trim().toLowerCase()
  // 保留历史进程名：升级后仍要排除旧版本窗口，避免把自己的日程重新识别为新任务。
  return [
    app.getName(),
    'electron',
    'GuziAssistant',
    'Guzi Assistant',
    '谷子助手',
    'gooz',
    '纸壳助手',
    'eshell'
  ].some(
    (n) => n && f.includes(n.toLowerCase())
  )
}

export function privacyForContext(context: {
  name: string
  bundleId: string
  windowTitle: string
  urlHost?: string | null
  focusedRole?: string
  focusedSubrole?: string
  targetRole?: string
  targetSubrole?: string
  secureInput?: boolean
}, historyOnly = false): {
  suppressed: boolean
  privacyState: 'normal' | 'private' | 'excluded' | 'own' | 'secure'
} {
  const settings = getSettings()
  const decision = decideHistoryPrivacy({
    appName: context.name,
    bundleId: context.bundleId,
    windowTitle: context.windowTitle,
    urlHost: historyOnly ? context.urlHost : undefined,
    focusedRole: context.focusedRole,
    focusedSubrole: context.focusedSubrole,
    targetRole: context.targetRole,
    targetSubrole: context.targetSubrole,
    secureInput: context.secureInput,
    ownAppNames: [
      app.getName(),
      'Electron',
      'GuziAssistant',
      'Guzi Assistant',
      '谷子助手',
      'Gooz',
      'EShell',
      '纸壳助手'
    ],
    excludedApps: settings.screenSenseExcludedApps,
    excludedBundleIds: historyOnly ? settings.historyExcludedApps.map((item) => item.bundleId) : [],
    excludedHosts: historyOnly ? settings.historyExcludedHosts : [],
    includedHosts: historyOnly ? settings.historyIncludedHosts : []
  })
  return { suppressed: !decision.persist, privacyState: decision.state }
}
