// IPC：谷子云端 MCP（统一账号登录、云端连接开关、本软件的 MCP token）。
// 通道清单以 src/shared/ipc-channels.ts 为准。
import { app, shell } from 'electron'
import { ipcMain } from './register'
import { getCloud } from '../cloud'

type Input = Record<string, string>

export function registerCloudIpc(): void {
  ipcMain.handle('cloud:state', () => getCloud().getState())
  ipcMain.handle('cloud:request-code', (_e, input: { purpose: 'register' | 'login' | 'reset'; email: string }) =>
    getCloud().requestCode(input)
  )
  ipcMain.handle('cloud:login', (_e, input: Input) => getCloud().login({ identifier: input.identifier, password: input.password }))
  ipcMain.handle('cloud:login-code', (_e, input: Input) => getCloud().loginWithCode({ email: input.email, code: input.code }))
  ipcMain.handle('cloud:register', (_e, input: Input) =>
    getCloud().register({ username: input.username, password: input.password, email: input.email, code: input.code })
  )
  ipcMain.handle('cloud:logout', () => getCloud().logout())
  ipcMain.handle('cloud:set-enabled', (_e, enabled: boolean) => getCloud().setEnabled(enabled === true))
  ipcMain.handle('cloud:tokens', () => getCloud().listTokens())
  ipcMain.handle('cloud:create-token', (_e, input: { name: string; bindDevice?: boolean }) =>
    getCloud().createToken({ name: String(input?.name ?? ''), bindDevice: input?.bindDevice === true })
  )
  ipcMain.handle('cloud:revoke-token', (_e, id: string) => getCloud().revokeToken(String(id)))
  ipcMain.handle('cloud:open-account', async () => {
    const url = new URL(getCloud().getState().accountUrl)
    if (url.protocol !== 'https:' && app.isPackaged) return
    await shell.openExternal(url.href)
  })
}
