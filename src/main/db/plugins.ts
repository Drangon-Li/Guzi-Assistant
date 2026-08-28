// 插件启用状态：存在 settings 表的 enabledPlugins 键里（一个 JSON 字符串数组）。
//
// 之所以不放进 AppSettings，是因为它不是用户偏好而是安装状态——preload 的通道前缀校验
// 和 initDb 的建表都要读它，语义上属于「装了什么」而不是「怎么用」。
// 应急回滚也简单：把这一行改成 '[]'，所有插件下线，核心功能不受影响。
import { getDb } from './connection.ts'
import { pruneEnabled, tablePrefix } from '@shared/plugin-manifest'
import { PLUGINS, findPlugin } from '@shared/plugin-registry'

const KEY = 'enabledPlugins'

/**
 * 已启用的插件 id。会顺手剔除注册表里已不存在的、以及硬依赖不全的条目——
 * 用户手改过库、或者某个插件在新版里被下掉时，不至于让主进程按残缺状态跑。
 */
export function readEnabledPlugins(): string[] {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined
  if (!row) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return pruneEnabled(PLUGINS, parsed.filter((x): x is string => typeof x === 'string'))
}

export function writeEnabledPlugins(ids: readonly string[]): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(KEY, JSON.stringify([...new Set(ids)]))
}

/**
 * 插件自己的偏好项，存在 settings 表的 plugin:<id>:<key> 下。
 * 插件不该往 AppSettings 里塞字段——那是核心的形状，加一个插件就动一次核心类型，
 * 停用插件后还会留下没人认领的键。
 */
export function readPluginSetting(id: string, key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`plugin:${id}:${key}`) as { value: string } | undefined
  return row?.value ?? null
}

export function writePluginSetting(id: string, key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(`plugin:${id}:${key}`, value)
}

/** 卸载时连偏好一起清掉，否则重装会带着上一轮的设置回来。 */
export function dropPluginSettings(id: string): void {
  getDb().prepare("DELETE FROM settings WHERE key LIKE ?").run(`plugin:${id}:%`)
}

/**
 * 卸载插件的数据。只删 manifest 声明过、且确实带本插件前缀的表。
 * 前缀在 validateManifest 里已经校验过一遍，这里删数据前再验一次是有意的：
 * 这是全仓少数几个 DROP TABLE 的地方，多一道不值钱，删错核心表则不可逆。
 */
export function dropPluginTables(id: string): void {
  const manifest = findPlugin(id)
  if (!manifest) return
  const prefix = tablePrefix(id)
  const db = getDb()
  for (const table of manifest.storage.tables) {
    if (!table.startsWith(prefix)) continue
    db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
}
