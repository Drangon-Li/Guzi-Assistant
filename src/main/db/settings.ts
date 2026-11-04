// profile / settings：用户档案与应用设置（key-value 表，读出来规整成 AppSettings）。
import { normalizeApiFormat } from '@shared/api-formats'
import { getDb } from './connection.ts'
import { loadEnv } from '../env'
import { firstNonBlank } from '@shared/env-value'
import { normalizeHistoryHost } from '@shared/history'
import { resolveDirectModelSettings } from '@shared/model-configuration'
import type { AppSettings, HistoryAppSelection, Profile } from '@shared/types'

// ---------- profile ----------

export function getProfile(): Profile | null {
  const row = getDb().prepare('SELECT data FROM profile WHERE id = 1').get() as { data: string } | undefined
  return row ? (JSON.parse(row.data) as Profile) : null
}

export function saveProfile(p: Profile): void {
  getDb().prepare(
    'INSERT INTO profile (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  ).run(JSON.stringify(p))
}

// ---------- settings ----------

// getSettings() 在每条活动事件、每轮屏幕监控、每次隐私判定里都会被调好几次，
// 而 settings 表里还躺着插件状态和逐日的活动对照行——每次全表读出再解析纯属浪费。
// AppSettings 的键只经 saveSettings 写入（插件/对照行用的是别的前缀，不影响这里），
// 所以在 saveSettings 里失效即可；按句柄记录，换库（测试、重新 initDb）自动重读。
// 返回的是共享快照：调用方只读，不要原地修改其中的字段或数组。
let settingsCache: { db: unknown; value: AppSettings } | null = null

export function getSettings(): AppSettings {
  const db = getDb()
  if (settingsCache?.db !== db) settingsCache = { db, value: readSettings() }
  return settingsCache.value
}

function readSettings(): AppSettings {
  const env = loadEnv()
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const directModel = resolveDirectModelSettings(map, env)
  // 兼容旧版本存的 hotkeyMode 枚举
  const legacy: Record<string, string> = {
    alt_c: 'Alt+C',
    alt_space: 'Alt+Space',
    cmd_shift_c: 'CommandOrControl+Shift+C'
  }
  return {
    starredTags: parseList(map.starredTags),
    hiddenTags: parseList(map.hiddenTags),
    customTags: parseList(map.customTags),
    hotkey: map.hotkey || legacy[map.hotkeyMode] || 'Control+\\',
    screenshotHotkey: map.screenshotHotkey || 'Control+Shift+\\',
    mainWindowHotkey: map.mainWindowHotkey || 'Alt+G',
    petVoiceHotkey: map.petVoiceHotkey || 'Alt+V',
    quickAskHotkey: map.quickAskHotkey || 'Alt+Space',
    // ?? 而不是 ||：用户显式清空后不能从 .env 静默复活
    apiFormat: normalizeApiFormat(map.apiFormat ?? env.GUZI_ASSISTANT_API_FORMAT),
    apiBase: directModel.apiBase,
    apiKey: directModel.apiKey,
    model: directModel.model,
    feishuAppId:
      map.feishuAppId ??
      firstNonBlank(env.GUZI_ASSISTANT_FEISHU_APP_ID, env.ESHELL_FEISHU_APP_ID),
    feishuAppSecret:
      map.feishuAppSecret ??
      firstNonBlank(env.GUZI_ASSISTANT_FEISHU_APP_SECRET, env.ESHELL_FEISHU_APP_SECRET),
    // 核心被动采集：默认关（opt-in，检测走云端解析、消耗 credits）
    screenSenseEnabled: map.screenSenseEnabled === 'true',
    screenSenseHotkey: map.screenSenseHotkey || 'Alt+S',
    screenSenseContinuous: map.screenSenseContinuous !== 'false',
    screenSenseIntervalSec: Number(map.screenSenseIntervalSec) || 5,
    screenSenseFallbackIntervalSec:
      map.screenSenseFallbackIntervalSec != null
        ? Math.min(60, Math.max(30, Number(map.screenSenseFallbackIntervalSec) || 45))
        : 45,
    // 排除名单空 = 不排除（不能像关键词那样回退默认词表）
    screenSenseExcludedApps: parseList(map.screenSenseExcludedApps),
    historyIncludedApps: parseList(map.historyIncludedApps),
    historyExcludedApps: parseHistoryAppList(map.historyExcludedApps),
    historyIncludedHosts: parseList(map.historyIncludedHosts)
      .map((value) => normalizeHistoryHost(value))
      .filter((value): value is string => value !== null),
    historyExcludedHosts: parseList(map.historyExcludedHosts)
      .map((value) => normalizeHistoryHost(value))
      .filter((value): value is string => value !== null),
    screenSenseKeepShots: map.screenSenseKeepShots === 'true',
    screenSenseRetentionDays: map.screenSenseRetentionDays != null ? Number(map.screenSenseRetentionDays) : 14,
    screenSensePopup: map.screenSensePopup !== 'false',
    screenSenseWorkLog: map.screenSenseWorkLog !== 'false',
    screenSenseVlmConfirm: map.screenSenseVlmConfirm === 'true',
    dailyReportTime: map.dailyReportTime ?? '',
    screenSenseCardHideSec:
      map.screenSenseCardHideSec != null ? Number(map.screenSenseCardHideSec) : 6,
    assistantAutoCloseSec: map.assistantAutoCloseSec != null ? Number(map.assistantAutoCloseSec) : 60,
    theme: map.theme === 'light' || map.theme === 'dark' ? map.theme : 'system',
    mcpEnabled: map.mcpEnabled === 'true',
    mcpPort: Number(map.mcpPort) || 38999,
    mcpToken: map.mcpToken ?? '',
    taskReminderEnabled: map.taskReminderEnabled !== 'false',
    taskReminderOffsetMin:
      map.taskReminderOffsetMin != null
        ? Math.min(1440, Math.max(0, Number(map.taskReminderOffsetMin) || 0))
        : 5,
    useCustomModel: map.useCustomModel === 'true',
    modelVision: map.modelVision ?? '',
    modelChat: map.modelChat ?? '',
    // Windows must read text to match patterns; require opt-in before the first read.
    clipWatchEnabled: process.platform === 'win32' ? map.clipWatchEnabled === 'true' : map.clipWatchEnabled !== 'false',
    todoScanEnabled: map.todoScanEnabled !== 'false',
    todoScanIntervalSec:
      map.todoScanIntervalSec != null
        ? Math.min(600, Math.max(60, Number(map.todoScanIntervalSec) || 180))
        : 180,
    // 默认开启：屏幕感知设置页不再暴露这个开关，留 false 的话没开过的用户永远开不了
    historyV2Enabled: map.historyV2Enabled !== 'false',
    historyCaptureText: map.historyCaptureText === 'true',
    voiceNotesEnabled: map.voiceNotesEnabled === 'true',
    voiceAutoStart: map.voiceAutoStart !== 'false',
    voiceKeepAudio: map.voiceKeepAudio === 'true',
    // 设置页填的优先；没填则回落到 .env，便于本地不把 key 存进库就能测
    voiceApiBase: map.voiceApiBase || env.GUZI_ASSISTANT_VOICE_API_BASE || '',
    voiceApiKey: map.voiceApiKey || env.GUZI_ASSISTANT_VOICE_API_KEY || '',
    voiceModel: map.voiceModel || env.GUZI_ASSISTANT_VOICE_MODEL || ''
  }
}

/** 逗号存储字符串 → 数组；空则返回空数组（无默认） */
function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 单个 History 排除 App 条目的规整：读库和写库共用，缺 bundleId 的丢弃。 */
function normalizeHistoryApp(item: unknown): HistoryAppSelection | null {
  if (!item || typeof item !== 'object') return null
  const value = item as Record<string, unknown>
  const bundleId = typeof value.bundleId === 'string' ? value.bundleId.trim() : ''
  if (!bundleId) return null
  return {
    bundleId,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : bundleId,
    path: typeof value.path === 'string' ? value.path.trim() : ''
  }
}

function parseHistoryAppList(raw: string | undefined): HistoryAppSelection[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.flatMap((item): HistoryAppSelection[] => {
      const app = normalizeHistoryApp(item)
      if (!app || seen.has(app.bundleId.toLowerCase())) return []
      seen.add(app.bundleId.toLowerCase())
      return [app]
    })
  } catch {
    return []
  }
}

export function saveSettings(patch: Partial<AppSettings>): void {
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  // 先失效再写：循环中途抛错时，已写入的部分也会在下一次读取时生效
  settingsCache = null
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === 'starredTags' || k === 'hiddenTags' || k === 'customTags') {
      const values = Array.isArray(v)
        ? v.filter((item): item is string => typeof item === 'string').map((item) => item.trim().replace(/,/g, '')).filter(Boolean)
        : []
      stmt.run(k, [...new Set(values)].join(','))
      continue
    }
    if (k === 'historyIncludedHosts' || k === 'historyExcludedHosts') {
      const values = Array.isArray(v)
        ? v.map((item) => normalizeHistoryHost(item)).filter((item): item is string => item !== null)
        : []
      stmt.run(k, values.join(','))
      continue
    }
    if (k === 'historyExcludedApps') {
      const values = Array.isArray(v)
        ? v.map(normalizeHistoryApp).filter((item): item is HistoryAppSelection => item !== null)
        : []
      const deduped = [...new Map(values.map((item) => [item.bundleId.toLowerCase(), item])).values()]
      stmt.run(k, JSON.stringify(deduped))
      continue
    }
    stmt.run(k, String(v))
  }
}
