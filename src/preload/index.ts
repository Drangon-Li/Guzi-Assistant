import { contextBridge, ipcRenderer, webUtils } from 'electron'
// preload 构建无 @shared 别名，走相对路径
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../shared/ipc-channels'
import { parsePluginChannel } from '../shared/plugin-manifest'
import { PLUGINS } from '../shared/plugin-registry'

// 通道白名单：渲染层即便被注入，也只能触达登记过的通道，挡掉任意 invoke（如 data:wipe / capture:files 滥用）
const INVOKE_SET: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const EVENT_SET: ReadonlySet<string> = new Set(EVENT_CHANNELS)

// 插件通道不逐条登记（启用时才动态注册），改按形状放行：必须是 plugin:<注册表里的 id>:<action>。
// 这里只管「id 是不是我们认识的插件」，「插件有没有启用」由主进程决定——
// 停用的插件没有 handler，invoke 会在 ipcMain 那里失败。少任何一层都不够。
const PLUGIN_IDS: ReadonlySet<string> = new Set(PLUGINS.map((p) => p.id))

function isAllowedInvoke(channel: string): boolean {
  if (INVOKE_SET.has(channel)) return true
  const parsed = parsePluginChannel(channel)
  return !!parsed && PLUGIN_IDS.has(parsed.id)
}

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!isAllowedInvoke(channel)) {
      return Promise.reject(new Error(`未授权的 IPC 通道: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!EVENT_SET.has(channel)) {
      console.warn(`[preload] 忽略未授权的事件通道订阅: ${channel}`)
      return () => {}
    }
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('guziAssistant', api)

export type GuziAssistantApi = typeof api
