import { contextBridge, ipcRenderer, webUtils } from 'electron'
// preload 构建无 @shared 别名，走相对路径
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../shared/ipc-channels'

// 通道白名单：渲染层即便被注入，也只能触达登记过的通道，挡掉任意 invoke（如 data:wipe / capture:files 滥用）
const INVOKE_SET: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const EVENT_SET: ReadonlySet<string> = new Set(EVENT_CHANNELS)

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!INVOKE_SET.has(channel)) {
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
