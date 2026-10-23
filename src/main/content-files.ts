import { rm } from 'fs/promises'
import { join } from 'path'

export async function clearUserContentFiles(userDataDir: string): Promise<void> {
  for (const name of ['shots', 'voice-notes', 'notebook-assets', 'history-v2', 'dropbox', 'screen-sense-debug.log']) {
    await rm(join(userDataDir, name), { recursive: true, force: true })
  }
}
