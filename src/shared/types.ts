export type SourceType =
  | 'clipboard_text'
  | 'clipboard_image'
  | 'clipboard_file'
  | 'screenshot'
  | 'file'
  | 'text_input'

export type ItemType = 'deadline' | 'meeting' | 'reminder' | 'preparation' | 'follow_up' | 'other'
export type Belongs = 'yes' | 'no' | 'uncertain'
export type UserRole = 'owner' | 'participant' | 'notified' | 'helper' | 'unclear'
export type Priority = 'high' | 'medium' | 'low' | 'unknown'
export type SuggestedAction = 'add' | 'confirm' | 'ignore' | 'ask_user'
export type ConfirmMode = 'conservative' | 'standard' | 'aggressive'
export type Identity = 'student' | 'worker' | 'freelancer'
export type HotkeyMode = 'space_c' | 'alt_space'

/** 文档 5.2 的七种任务状态 */
export type TaskStatus =
  | 'pending' // 待确认
  | 'not_started' // 未开始
  | 'scheduled' // 已安排
  | 'in_progress' // 进行中
  | 'done' // 已完成
  | 'overdue' // 已延期
  | 'ignored' // 已忽略

export interface Profile {
  name: string
  nicknames: string[]
  accounts: string[]
  identity: Identity
  org: string
  group: string
  workHours: string
  confirmMode: ConfirmMode
}

export interface SourceRecord {
  id: string
  type: SourceType
  excerpt: string
  content: string | null
  filePath: string | null
  createdAt: string
  deleted: boolean
}

export interface TaskRecord {
  id: string
  sourceId: string | null
  title: string
  itemType: ItemType
  belongsToUser: Belongs
  belongingReason: string
  userRole: UserRole
  startTime: string | null
  dueTime: string | null
  location: string | null
  priority: Priority
  confidence: number
  suggestedAction: SuggestedAction
  evidence: string[]
  status: TaskStatus
  feedback: string | null
  createdAt: string
  updatedAt: string
}

/** 预览卡上展示的待提交内容 */
export interface PendingCapture {
  captureId: string
  type: SourceType
  kind: 'text' | 'image' | 'file'
  excerpt: string
  charCount: number
  fileName: string | null
  thumbnailDataUrl: string | null
  sensitiveHits: string[]
}

export interface ParseSummary {
  sourceId: string
  total: number
  related: number
  autoAdded: number
  error: string | null
}

export interface PermissionStatus {
  accessibility: boolean
  screen: string
  apiConfigured: boolean
}

export interface AppSettings {
  hotkeyMode: HotkeyMode
  apiBase: string
  apiKey: string
  model: string
}
