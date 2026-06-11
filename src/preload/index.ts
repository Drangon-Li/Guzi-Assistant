import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('al1', api)

export type Al1Api = typeof api
