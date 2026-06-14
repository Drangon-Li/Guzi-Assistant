export interface EShellApi {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, cb: (payload: unknown) => void) => () => void
  pathForFile: (file: File) => string
}

declare global {
  interface Window {
    eshell: EShellApi
  }
}

export {}
