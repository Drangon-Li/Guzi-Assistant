// 插件在主进程侧的装配：模块表、建表、IPC handler 的动态注册、启停与卸载。
//
// 安全模型分两层，缺一不可：
//   preload 按 plugin:<已知 id>:<action> 的形状放行（挡住任意通道名）；
//   这里只给**已启用**的插件注册 handler（挡住停用插件的通道）。
//   两层都过不了的 invoke 会在 ipcMain 那里因为没有 handler 而直接 reject。
import { app, ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import {
  assistantActionsBlock,
  buildPluginStates,
  disableChain,
  enableChain,
  isKnownAssistantAction,
  pluginChannel,
  pluginEventName,
  type PluginState
} from '@shared/plugin-manifest'
import { PLUGINS } from '@shared/plugin-registry'
import {
  dropPluginSettings,
  dropPluginTables,
  readEnabledPlugins,
  writeEnabledPlugins
} from '../db/plugins.ts'
import { getDb } from '../db/connection.ts'
import { broadcast } from '../windows'
import achievement from './achievement/index.ts'
import habit from './habit/index.ts'
import pomodoro from './pomodoro/index.ts'
import timeblock from './timeblock/index.ts'
import type { AssistantActionResult, PluginMainModule } from './types.ts'

export const PLUGIN_MODULES: Record<string, PluginMainModule> = {
  timeblock,
  pomodoro,
  habit,
  achievement
}

/**
 * initDb 尾部调用：给已启用的插件建表（幂等）。
 * 单个插件建表失败不该拖垮启动——其余插件和核心功能照常，失败的那个下次启动重试。
 */
export function initEnabledPluginTables(db: Database.Database): void {
  for (const id of readEnabledPlugins()) {
    try {
      PLUGIN_MODULES[id]?.initTables(db)
    } catch (e) {
      console.error(`[plugins] ${id} 建表失败：`, e)
    }
  }
}

/**
 * 发出一个插件事件。发出方不需要知道谁在听——没装的插件不在 enabled 里，
 * 循环自然跳过；装了但没写这个监听器的，查表也查不到。
 * 一个监听器抛异常不影响其它监听器，更不影响发出方。
 *
 * 同时广播到渲染层（`guzi-assistant:plugin-event`），好让已经打开的插件页跟着刷新。
 */
export function emitPluginEvent(
  from: string,
  name: string,
  payload: Record<string, unknown> = {}
): void {
  const event = pluginEventName(from, name)
  const enabled = readEnabledPlugins()
  if (!enabled.includes(from)) return

  for (const id of enabled) {
    if (id === from) continue
    const handler = PLUGIN_MODULES[id]?.on?.[event]
    if (!handler) continue
    try {
      handler(payload)
    } catch (e) {
      console.error(`[plugins] ${id} 处理事件 ${event} 失败：`, e)
    }
  }
  broadcast('guzi-assistant:plugin-event', { event, from, name, payload })
}

function registerHandlers(id: string): void {
  const mod = PLUGIN_MODULES[id]
  if (!mod) return
  for (const [action, handler] of Object.entries(mod.handlers)) {
    const channel = pluginChannel(id, action)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_e, ...args: unknown[]) => handler(...args))
  }
}

function unregisterHandlers(id: string): void {
  const mod = PLUGIN_MODULES[id]
  if (!mod) return
  for (const action of Object.keys(mod.handlers)) ipcMain.removeHandler(pluginChannel(id, action))
}

/** 启动时给已启用的插件挂上 handler，并跑一次各自的 init（重挂定时器之类）。 */
export function initPluginIpc(): void {
  for (const id of readEnabledPlugins()) {
    registerHandlers(id)
    runInit(id)
  }
}

function runInit(id: string): void {
  try {
    PLUGIN_MODULES[id]?.init?.()
  } catch (e) {
    console.error(`[plugins] ${id} init 失败：`, e)
  }
}

function runDispose(id: string): void {
  try {
    PLUGIN_MODULES[id]?.dispose?.()
  } catch (e) {
    console.error(`[plugins] ${id} dispose 失败：`, e)
  }
}

export function states(): PluginState[] {
  return buildPluginStates(PLUGINS, readEnabledPlugins(), app.getVersion())
}

/** 已启用插件的助手动作清单，拼进对话提示词。 */
export function assistantActions(): string {
  return assistantActionsBlock(PLUGINS, readEnabledPlugins())
}

/**
 * 执行一次助手动作。三道门：插件已启用、manifest 里声明过、实现里确实有这个函数。
 * 模型可能编出不存在的插件或动作，任何一道不过就当没这回事，不让它影响这一轮对话。
 */
export function runAssistantAction(
  plugin: string,
  action: string,
  args: Record<string, unknown>
): AssistantActionResult | null {
  if (!isKnownAssistantAction(PLUGINS, readEnabledPlugins(), plugin, action)) return null
  const fn = PLUGIN_MODULES[plugin]?.assistantActions?.[action]
  if (!fn) return null
  try {
    return fn(args)
  } catch (e) {
    console.error(`[plugins] 助手动作 ${plugin}:${action} 执行失败：`, e)
    return { ok: false, message: '没能执行' }
  }
}

/** 启用插件及其硬依赖；返回实际被启用的 id（依赖在前）。 */
export function enablePlugin(id: string): { enabled: string[]; added: string[] } {
  const current = readEnabledPlugins()
  const added = enableChain(PLUGINS, current, id)
  if (!added.length) return { enabled: current, added: [] }

  const db = getDb()
  for (const pid of added) PLUGIN_MODULES[pid]?.initTables(db)
  const next = [...current, ...added]
  writeEnabledPlugins(next)
  for (const pid of added) {
    registerHandlers(pid)
    runInit(pid)
  }
  return { enabled: next, added }
}

/**
 * 停用插件及其依赖者。只摘导航和 handler，数据留着——
 * 重新启用时进度和记录都还在，这是「停用」和「卸载」的唯一区别。
 */
export function disablePlugin(id: string): { enabled: string[]; removed: string[] } {
  const current = readEnabledPlugins()
  const removed = disableChain(PLUGINS, current, id)
  if (!removed.length) return { enabled: current, removed: [] }

  const next = current.filter((x) => !removed.includes(x))
  writeEnabledPlugins(next)
  // 先 dispose 再摘 handler：停用的插件不该继续在后台跑定时器
  for (const pid of removed) {
    runDispose(pid)
    unregisterHandlers(pid)
  }
  return { enabled: next, removed }
}

/** 卸载：先停用（含级联），再删掉这些插件的表和偏好。不可逆。 */
export function uninstallPlugin(id: string): { enabled: string[]; removed: string[] } {
  const result = disablePlugin(id)
  const targets = result.removed.length ? result.removed : [id]
  for (const pid of targets) {
    dropPluginTables(pid)
    dropPluginSettings(pid)
  }
  return result
}
