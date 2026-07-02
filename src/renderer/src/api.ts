import type {
  AppSettings,
  AppUsageEntry,
  FeishuStatus,
  ParseSummary,
  PendingCapture,
  PermissionStatus,
  Profile,
  ReportRecord,
  ScanResult,
  SourceRecord,
  TaskRecord,
  TaskStatus,
  WorkRecord
} from '@shared/types'
import type {
  AddedInfo,
  AssistantTurnResult,
  CandidateContext,
  ChatHistoryItem,
  ParsedItem
} from '@shared/parsing'

interface PersonalMemoryDto {
  base: string
  recent: string
  updatedAt: string | null
}

function inv<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.eshell.invoke(channel, ...args) as Promise<T>
}

export const api = {
  getProfile: () => inv<Profile | null>('profile:get'),
  saveProfile: (p: Profile) => inv<void>('profile:save', p),

  setSession: (functionsBase: string, token: string | null) =>
    inv<void>('auth:set-session', { functionsBase, token }),

  getSettings: () => inv<AppSettings>('settings:get'),
  /** 返回 false 表示快捷键注册失败（被其他应用占用） */
  saveSettings: (patch: Partial<AppSettings>) => inv<boolean>('settings:save', patch),

  listTasks: () => inv<TaskRecord[]>('tasks:list'),
  updateTask: (id: string, patch: Partial<TaskRecord>) => inv<void>('tasks:update', id, patch),
  bulkTasks: (ids: string[], status: TaskStatus) => inv<void>('tasks:bulk', ids, status),

  captureFiles: (paths: string[]) => inv<ParseSummary[]>('capture:files', paths),
  captureScreenshot: () => inv<ParseSummary | null>('capture:screenshot'),
  captureClipboard: () => inv<void>('capture:clipboard'),

  previewSubmit: (captureId: string) => inv<ParseSummary>('preview:submit', captureId),
  previewCancel: (captureId: string) => inv<void>('preview:cancel', captureId),
  previewHide: () => inv<void>('preview:hide'),

  getSource: (id: string) => inv<SourceRecord | null>('source:get', id),
  deleteSource: (id: string) => inv<void>('source:delete', id),
  readShot: (id: string) => inv<string | null>('memory:read-shot', id),
  wipeMemory: () => inv<void>('memory:wipe'),

  wipeData: () => inv<void>('data:wipe'),
  permissions: () => inv<PermissionStatus>('permissions:get'),
  openScreenSettings: () => inv<void>('permissions:open-screen-settings'),
  quickActionStatus: () => inv<boolean>('quickaction:status'),
  installQuickAction: () => inv<boolean>('quickaction:install'),
  feishuStatus: () => inv<FeishuStatus>('feishu:status'),

  screenScan: () => inv<ScanResult>('screen:scan'),
  suggestionAccept: (payload: { item: ParsedItem; sourceText: string }) =>
    inv<AddedInfo>('suggestion:accept', payload),
  acceptLocal: (payload: { item: ParsedItem; sourceText: string; detectionId?: string }) =>
    inv<AddedInfo>('suggestion:accept-local', payload),
  dismissDetection: (id: string) => inv<void>('detections:dismiss', id),

  listWorkRecords: (day: string) => inv<WorkRecord[]>('work-records:list', day),
  workRecordsSince: (sinceDay: string) => inv<WorkRecord[]>('work-records:since', sinceDay),
  deleteWorkRecord: (id: string) => inv<void>('work-records:delete', id),
  getPersonalMemory: () => inv<PersonalMemoryDto>('memory:get-personal'),
  setPersonalMemory: (part: 'base' | 'recent', content: string) =>
    inv<PersonalMemoryDto>('memory:set-personal', part, content),
  refreshPersonalMemory: (part: 'base' | 'recent' = 'recent') =>
    inv<PersonalMemoryDto>('memory:refresh-personal', part),
  focusTaskPrefs: () => inv<{ name: string; hidden: boolean; custom: boolean }[]>('focus-tasks:prefs'),
  addFocusTask: (name: string) => inv<void>('focus-tasks:add', name),
  hideFocusTask: (name: string) => inv<void>('focus-tasks:hide', name),
  exportRange: (fromDay: string, toDay: string) => inv<boolean>('data:export-range', fromDay, toDay),
  appUsageSummary: (day: string) => inv<AppUsageEntry[]>('app-usage:summary', day),
  generateReport: (day: string) => inv<ReportRecord>('reports:generate', day),
  listReports: () => inv<ReportRecord[]>('reports:list'),
  deleteReport: (id: string) => inv<void>('reports:delete', id),
  exportReport: (r: { title: string; content: string }) => inv<boolean>('report:export', r),

  assistantChat: (payload: { history: ChatHistoryItem[]; candidates: CandidateContext | null }) =>
    inv<AssistantTurnResult>('assistant:chat', payload),
  assistantAdd: (payload: { sourceText: string; item: ParsedItem; force?: boolean }) =>
    inv<AddedInfo>('assistant:add', payload),
  focusMain: (route?: string) => inv<void>('app:focus-main', route),

  exportTaskIcs: (task: TaskRecord) =>
    inv<{ ok: boolean; canceled?: boolean; error?: string }>('task:export-ics', task),

  /** 打开充值支付窗口（chpay 表单 POST 跳转） */
  openPayment: (payUrl: string, params: Record<string, string>) =>
    inv<void>('payment:open', payUrl, params),
  /** 关闭充值支付窗口（支付成功 / 取消） */
  closePayment: () => inv<void>('payment:close'),

  petGetPrefs: () =>
    inv<{ enabled: boolean; scale: number; paused: boolean; bubbles: boolean }>('pet:get-prefs'),
  petSetEnabled: (v: boolean) => inv<void>('pet:set-enabled', v),
  petSetBubbles: (v: boolean) => inv<void>('pet:set-bubbles', v),
  petSetScale: (v: number) => inv<void>('pet:set-scale', v),
  petSetPaused: (v: boolean) => inv<void>('pet:set-paused', v),
  petResetPosition: () => inv<void>('pet:reset-position'),
  petChatHide: () => inv<void>('pet:chat-hide'),
  themeGet: () => inv<boolean>('theme:get'),

  on: (channel: string, cb: (payload: unknown) => void) => window.eshell.on(channel, cb)
}

export type { PendingCapture }
