import { rm } from 'fs/promises'
import { join } from 'path'

export async function clearUserContentFiles(userDataDir: string): Promise<void> {
  // 诊断日志会轮转出一份 .1（见 windows.ts），里面同样有窗口标题，要一起删
  for (const name of ['shots', 'voice-notes', 'notebook-assets', 'history-v2', 'dropbox', 'screen-sense-debug.log', 'screen-sense-debug.log.1']) {
    await rm(join(userDataDir, name), { recursive: true, force: true })
  }
}
