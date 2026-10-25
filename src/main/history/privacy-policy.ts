import { isAppExcluded, isAppIncluded, isBundleIdExcluded } from '../../shared/app-exclude.ts'
import { normalizeHistoryHost } from '../../shared/history.ts'
import type { HistoryPrivacyState } from './event-schema.ts'

export interface HistoryPrivacyInput {
  appName?: string | null
  bundleId?: string | null
  windowTitle?: string | null
  focusedRole?: string | null
  focusedSubrole?: string | null
  targetRole?: string | null
  targetSubrole?: string | null
  secureInput?: boolean
  suppressed?: boolean
  ownAppNames?: string[]
  excludedApps?: string[]
  excludedBundleIds?: string[]
  includedApps?: string[]
  urlHost?: string | null
  excludedHosts?: string[]
  includedHosts?: string[]
}

export interface HistoryPrivacyDecision {
  state: HistoryPrivacyState
  persist: boolean
  reason: string
}

const BROWSER_BUNDLES = new Set([
  'com.apple.safari',
  'com.google.chrome',
  'com.microsoft.edgemac',
  'org.mozilla.firefox',
  'com.brave.browser',
  'company.thebrowser.browser'
])

export function isBrowserIdentity(bundleId: string | null | undefined): boolean {
  const identity = (bundleId ?? '').trim().toLowerCase()
  return BROWSER_BUNDLES.has(identity) || /^win32:(?:chrome|msedge|firefox|brave|vivaldi|opera|arc|chromium)\.exe:[0-9a-f]{16}$/.test(identity)
}
const PRIVATE_TITLE =
  /private browsing|private window|incognito|inprivate|无痕|無痕|私密浏览|私密瀏覽|シークレット|プライベート|시크릿|프라이빗/i

/** Shared title safeguard; native collectors also inspect platform browser controls. */
export function isPrivateBrowserWindow(
  bundleId: string | null | undefined,
  windowTitle: string | null | undefined
): boolean {
  return isBrowserIdentity(bundleId) && PRIVATE_TITLE.test(windowTitle ?? '')
}

function includesApp(appName: string | null | undefined, candidates: string[]): boolean {
  if (!appName) return false
  const value = appName.trim().toLowerCase()
  return candidates.some((item) => {
    const candidate = item.trim().toLowerCase()
    return candidate !== '' && value.includes(candidate)
  })
}

function hostParts(value: string): { name: string; port: string | null } {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return { name: value.slice(1, end), port: value.slice(end + 1).replace(/^:/, '') || null }
  }
  const separator = value.lastIndexOf(':')
  if (separator > -1 && /^\d+$/.test(value.slice(separator + 1)))
    return { name: value.slice(0, separator), port: value.slice(separator + 1) }
  return { name: value, port: null }
}

/** Match a host and its subdomains while preserving an explicitly configured port. */
function hostMatches(actual: string, candidate: string): boolean {
  const left = hostParts(actual)
  const right = hostParts(candidate)
  if (right.port != null && left.port !== right.port) return false
  return left.name === right.name || left.name.endsWith(`.${right.name}`)
}

function matchesHostList(host: string, candidates: string[]): boolean {
  return candidates.some((candidate) => {
    const normalized = normalizeHistoryHost(candidate)
    return normalized != null && hostMatches(host, normalized)
  })
}

/** Pure privacy gate shared by persistence and fixture tests. */
export function decideHistoryPrivacy(input: HistoryPrivacyInput): HistoryPrivacyDecision {
  const executable = /^win32:([^:]+\.exe):[0-9a-f]{16}$/i.exec(input.bundleId ?? '')?.[1]
  const role = `${input.focusedRole ?? ''} ${input.focusedSubrole ?? ''} ${input.targetRole ?? ''} ${input.targetSubrole ?? ''}`
  if (input.secureInput || /secure|password|secret/i.test(role))
    return { state: 'secure', persist: false, reason: 'secure_input' }
  if (includesApp(input.appName, input.ownAppNames ?? []))
    return { state: 'own', persist: false, reason: 'own_app' }
  if (isBundleIdExcluded(input.bundleId, input.excludedBundleIds ?? []))
    return { state: 'excluded', persist: false, reason: 'excluded_app' }
  if (isAppExcluded(input.appName, input.excludedApps ?? []) || isAppExcluded(executable, input.excludedApps ?? []))
    return { state: 'excluded', persist: false, reason: 'excluded_app' }
  if (isPrivateBrowserWindow(input.bundleId, input.windowTitle))
    return { state: 'private', persist: false, reason: 'private_browser' }
  if (!isAppIncluded(input.appName, input.includedApps ?? []) && !isAppIncluded(executable, input.includedApps ?? []))
    return { state: 'excluded', persist: false, reason: 'not_included_app' }
  if (input.suppressed) return { state: 'excluded', persist: false, reason: 'suppressed' }

  const rawHost = typeof input.urlHost === 'string' ? input.urlHost.trim() : ''
  const host = rawHost ? normalizeHistoryHost(rawHost) : null
  if (rawHost && !host) return { state: 'excluded', persist: false, reason: 'invalid_url_host' }
  if (!host && isBrowserIdentity(input.bundleId) &&
    ((input.excludedHosts?.length ?? 0) > 0 || (input.includedHosts?.length ?? 0) > 0))
    return { state: 'excluded', persist: false, reason: 'unknown_browser_host' }
  if (host && matchesHostList(host, input.excludedHosts ?? []))
    return { state: 'excluded', persist: false, reason: 'excluded_host' }
  if (host && (input.includedHosts ?? []).length && !matchesHostList(host, input.includedHosts ?? []))
    return { state: 'excluded', persist: false, reason: 'not_included_host' }
  return { state: 'normal', persist: true, reason: 'normal' }
}
