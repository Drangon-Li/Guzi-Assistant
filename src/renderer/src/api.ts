import type {
  AppSettings,
  DetectionRecord,
  FeishuStatus,
  MemoryHit,
  ParseSummary,
  PendingCapture,
  PermissionStatus,
  Profile,
  ScanResult,
  SourceRecord,
  TaskRecord,
  TaskStatus
} from '@shared/types'
import type {
  AddedInfo,
  AssistantTurnResult,
  CandidateContext,
  ChatHistoryItem,
  ParsedItem
} from '@shared/parsing'

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
  searchMemory: (query: string) => inv<MemoryHit[]>('memory:search', query),
  readShot: (id: string) => inv<string | null>('memory:read-shot', id),

  wipeData: () => inv<void>('data:wipe'),
  permissions: () => inv<PermissionStatus>('permissions:get'),
  openScreenSettings: () => inv<void>('permissions:open-screen-settings'),
  quickActionStatus: () => inv<boolean>('quickaction:status'),
  installQuickAction: () => inv<boolean>('quickaction:install'),
  feishuStatus: () => inv<FeishuStatus>('feishu:status'),

  screenScan: () => inv<ScanResult>('screen:scan'),
  suggestionAccept: (payload: { item: ParsedItem; sourceText: string }) =>
    inv<AddedInfo>('suggestion:accept', payload),
  suggestionAiParse: (sourceText: string) =>
    inv<{ item: ParsedItem; sourceText: string; hits: string[] } | null>(
      'suggestion:ai-parse',
      sourceText
    ),
  acceptLocal: (payload: {
    title: string
    isoTime: string | null
    deadline: boolean
    sourceText: string
    detectionId?: string
  }) => inv<AddedInfo>('suggestion:accept-local', payload),
  listDetections: () => inv<DetectionRecord[]>('detections:list'),
  acceptDetection: (id: string) => inv<AddedInfo | null>('detections:accept', id),
  dismissDetection: (id: string) => inv<void>('detections:dismiss', id),

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

  petGetPrefs: () => inv<{ enabled: boolean; scale: number; paused: boolean }>('pet:get-prefs'),
  petSetEnabled: (v: boolean) => inv<void>('pet:set-enabled', v),
  petSetScale: (v: number) => inv<void>('pet:set-scale', v),
  petSetPaused: (v: boolean) => inv<void>('pet:set-paused', v),
  petResetPosition: () => inv<void>('pet:reset-position'),

  on: (channel: string, cb: (payload: unknown) => void) => window.eshell.on(channel, cb)
}

export type { PendingCapture }
