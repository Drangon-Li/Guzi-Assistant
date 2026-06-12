import type {
  AppSettings,
  ParseSummary,
  PendingCapture,
  PermissionStatus,
  Profile,
  SourceRecord,
  TaskRecord,
  TaskStatus
} from '@shared/types'

function inv<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.al1.invoke(channel, ...args) as Promise<T>
}

export const api = {
  getProfile: () => inv<Profile | null>('profile:get'),
  saveProfile: (p: Profile) => inv<void>('profile:save', p),

  getSettings: () => inv<AppSettings>('settings:get'),
  /** 返回 false 表示快捷键注册失败（被其他应用占用） */
  saveSettings: (patch: Partial<AppSettings>) => inv<boolean>('settings:save', patch),

  listTasks: () => inv<TaskRecord[]>('tasks:list'),
  updateTask: (id: string, patch: Partial<TaskRecord>) => inv<void>('tasks:update', id, patch),
  bulkTasks: (ids: string[], status: TaskStatus) => inv<void>('tasks:bulk', ids, status),

  captureText: (text: string) => inv<ParseSummary>('capture:text', text),
  captureFiles: (paths: string[]) => inv<ParseSummary[]>('capture:files', paths),
  captureScreenshot: () => inv<ParseSummary | null>('capture:screenshot'),
  captureClipboard: () => inv<void>('capture:clipboard'),

  previewSubmit: (captureId: string) => inv<ParseSummary>('preview:submit', captureId),
  previewCancel: (captureId: string) => inv<void>('preview:cancel', captureId),
  previewHide: () => inv<void>('preview:hide'),

  getSource: (id: string) => inv<SourceRecord | null>('source:get', id),
  deleteSource: (id: string) => inv<void>('source:delete', id),

  wipeData: () => inv<void>('data:wipe'),
  permissions: () => inv<PermissionStatus>('permissions:get'),
  quickActionStatus: () => inv<boolean>('quickaction:status'),
  installQuickAction: () => inv<boolean>('quickaction:install'),
  focusMain: (route?: string) => inv<void>('app:focus-main', route),

  on: (channel: string, cb: (payload: unknown) => void) => window.al1.on(channel, cb)
}

export type { PendingCapture }
