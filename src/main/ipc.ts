// 主进程 IPC 入口：按领域拆在 ./ipc/ 下，这里只负责按顺序挂上。
// 新增通道：先登记到 src/shared/ipc-channels.ts，再加到对应领域文件（test/ipc-channels-smoke.mjs 两头校验）。
import { ipcMain as rawIpcMain } from 'electron'
import { CONTENT_EPOCH_CHANNEL } from '@shared/ipc-channels'
import { captureContentEpoch, isContentResetting } from './content-lifecycle'
import { registerSettingsIpc } from './ipc/settings'
import { registerVoiceIpc } from './ipc/voice'
import { registerCaptureIpc } from './ipc/capture'
import { registerTaskIpc } from './ipc/task'
import { registerActivityIpc } from './ipc/activity'
import { registerAppIpc } from './ipc/app'

export { triggerClipboardCapture, triggerScreenshotCapture } from './ipc/capture'

export function registerIpc(): void {
  rawIpcMain.on(CONTENT_EPOCH_CHANNEL, (event) => {
    event.returnValue = isContentResetting() ? null : captureContentEpoch()
  })
  registerSettingsIpc()
  registerVoiceIpc()
  registerCaptureIpc()
  registerTaskIpc()
  registerActivityIpc()
  registerAppIpc()
}
