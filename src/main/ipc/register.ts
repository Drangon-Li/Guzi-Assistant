// 所有 IPC handler 的统一注册入口：每个 invoke 都带内容纪元校验（清除数据期间的迟到调用直接拒绝），
// 会产生内容的通道还要登记成退出期间的在途工作；更新/退出类通道只接受应用自己窗口的主框架。
import { ipcMain as rawIpcMain } from 'electron'
import { getExitWindows } from '../windows'
import { assertExitWorkAllowed, trackExitWork } from '../exit-lifecycle'
import { withContentEpoch } from '../content-ipc'

const exitGuardedChannels = new Set([
  'voice:start', 'tasks:quick-add', 'assistant:chat', 'assistant:quick-chat', 'reports:generate', 'history:summarize',
  'capture:clipboard', 'capture:files', 'capture:screenshot', 'preview:submit'
])
export const ipcMain = {
  handle: (channel: string, listener: Parameters<typeof rawIpcMain.handle>[1]): void => {
    rawIpcMain.handle(channel, withContentEpoch((event, ...args) => {
      if (channel.startsWith('app:') && (channel.includes('update') || channel === 'app:exit-response')) {
        if (event.senderFrame !== event.sender.mainFrame || !getExitWindows().some((win) => win.webContents.id === event.sender.id)) {
          throw new Error('无效的应用操作来源')
        }
      }
      if (exitGuardedChannels.has(channel)) {
        assertExitWorkAllowed()
        return trackExitWork(Promise.resolve(listener(event, ...args)))
      }
      return listener(event, ...args)
    }, channel === 'data:wipe'))
  }
}
