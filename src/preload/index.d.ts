export interface GuziAssistantApi {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, cb: (payload: unknown) => void) => () => void
  pathForFile: (file: File) => string
}

declare global {
  interface Window {
    guziAssistant: GuziAssistantApi
  }
}

export {}
