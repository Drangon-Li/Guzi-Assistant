// IPC：语音纪要：录制会话的启停、分段与转录探测。
// 通道清单以 src/shared/ipc-channels.ts 为准；这里只是按领域归位的注册。
import { ipcMain } from './register'
import { listVoiceSessions } from '../db'
import { probeTranscription } from '../voicenotes/transcribe'
import {
  acknowledgeVoiceCaptureStopped,
  currentVoiceSession,
  ingestSegment,
  startVoiceSession,
  stopVoiceSession
} from '../voicenotes/service'
import type { PcmSegment } from '@shared/voicenotes'

export function registerVoiceIpc(): void {
  // ---------- 语音纪要 ----------
  ipcMain.handle('voice:probe', () => probeTranscription())
  ipcMain.handle('voice:start', () => startVoiceSession(null))
  ipcMain.handle('voice:stop', () => stopVoiceSession())
  ipcMain.handle('voice:capture-stopped', (_e, id: string) => acknowledgeVoiceCaptureStopped(id))
  ipcMain.handle('voice:state', () => currentVoiceSession())
  ipcMain.handle('voice:sessions', () => listVoiceSessions())
  ipcMain.handle('voice:segment', (_e, segment: PcmSegment) => ingestSegment(segment))
}
