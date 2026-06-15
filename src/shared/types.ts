export type SourceType =
  | 'clipboard_text'
  | 'clipboard_image'
  | 'clipboard_file'
  | 'screenshot'
  | 'file'
  | 'text_input'
  | 'feishu'
  | 'screen_scan'

export type ItemType = 'deadline' | 'meeting' | 'reminder' | 'preparation' | 'follow_up' | 'other'
export type Belongs = 'yes' | 'no' | 'uncertain'
export type UserRole = 'owner' | 'participant' | 'notified' | 'helper' | 'unclear'
export type Priority = 'high' | 'medium' | 'low' | 'unknown'
export type SuggestedAction = 'add' | 'confirm' | 'ignore' | 'ask_user'
export type ConfirmMode = 'conservative' | 'standard' | 'aggressive'
export type Identity = 'student' | 'worker' | 'freelancer'

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
  /** #15 归属个性化：通常「不是本人」的称呼/账号/角色词，注入解析 prompt 作先验（可选，迁移安全） */
  belongingNotMine?: string[]
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

/** #52 记忆检索命中：来源 + 高亮片段 + 其派生任务数 */
export interface MemoryHit {
  source: SourceRecord
  snippet: string
  taskCount: number
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
  /** 注意事项/须知，AI 从原文提炼 */
  notes: string[]
  /** 疑似与之重复的已有任务标题（AI 语义查重结果） */
  duplicateOf: string | null
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
  /** 与已有任务重复而被跳过的数量 */
  duplicates: number
  error: string | null
}

export interface PermissionStatus {
  screen: string
  apiConfigured: boolean
}

export interface AppSettings {
  /** Electron accelerator 字符串，如 "Alt+C"、"Command+Shift+K" */
  hotkey: string
  apiBase: string
  apiKey: string
  model: string
  feishuAppId: string
  feishuAppSecret: string
  /** 屏幕感知建议：opt-in 开关，默认 false */
  screenSenseEnabled: boolean
  /** 触发解析的关键词 */
  screenSenseKeywords: string[]
  /** 扫描屏幕的全局快捷键 accelerator */
  screenSenseHotkey: string
  /** 持续屏幕监控（#40）：screenSenseEnabled 之下的二级开关，默认 false */
  screenSenseContinuous: boolean
  /** 持续监控轮询间隔（秒），默认 5 */
  screenSenseIntervalSec: number
  /** 应用排除名单（#40 隐私门）：这些 App 在前台时连截图都不做，默认空（不排除） */
  screenSenseExcludedApps: string[]
}

export interface FeishuStatus {
  status: 'disabled' | 'connecting' | 'connected' | 'error' | 'restart_required'
  detail: string
}

export interface ScanResult {
  status: 'suggested' | 'empty' | 'error'
  message: string
}
