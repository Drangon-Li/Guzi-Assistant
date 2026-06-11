export interface Al1Api {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, cb: (payload: unknown) => void) => () => void
  pathForFile: (file: File) => string
}

declare global {
  interface Window {
    al1: Al1Api
  }
}

export {}
