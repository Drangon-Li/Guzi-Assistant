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

/** 屏幕感知本地检测记录：被动留存到「记忆」页回看。status: new=待处理 / accepted=已加入 / dismissed=已忽略 */
export interface DetectionRecord {
  id: string
  title: string
  timeIso: string | null
  deadline: boolean
  sourceText: string
  hits: string[]
  app: string | null
  status: 'new' | 'accepted' | 'dismissed'
  createdAt: string
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
  /** 提交屏幕截图（交互框选截图 → 解析）的全局快捷键 */
  screenshotHotkey: string
  apiBase: string
  apiKey: string
  model: string
  feishuAppId: string
  feishuAppSecret: string
  /** 屏幕感知：核心被动采集总开关。默认 false（opt-in，检测走云端解析、消耗 credits） */
  screenSenseEnabled: boolean
  /** 扫描屏幕的全局快捷键 accelerator */
  screenSenseHotkey: string
  /** 持续屏幕监控（#40）：screenSenseEnabled 之下的二级开关，默认 true（被动持续感知） */
  screenSenseContinuous: boolean
  /** 持续监控轮询间隔（秒），默认 5 */
  screenSenseIntervalSec: number
  /** 应用排除名单（#40 隐私门）：这些 App 在前台时连截图都不做，默认空（不排除） */
  screenSenseExcludedApps: string[]
  /** 持久化任务证据缩略图（#52/#53/#3）：默认 true（裁「依据行」横条、加密落盘、任务完成即清）。设 'false' 关 */
  screenSenseKeepShots: boolean
  /** 截图保留天数（#53），到期自动清；<=0 永久保留。默认 14 */
  screenSenseRetentionDays: number
  /** 检测到日程时是否主动弹卡；false=完全被动（只进「记忆」历史，不打扰）。默认 true */
  screenSensePopup: boolean
  /** 工作记录：屏幕识别时顺带记录「在做什么」（同一次云端调用，零额外成本）。默认 true */
  screenSenseWorkLog: boolean
  /** 日程深度确认：文字检出日程候选后，把截图发视觉模型二次确认（更准，但**截图会上云**）。默认 false */
  screenSenseVlmConfirm: boolean
  /** 每日定时自动生成日报的时间（HH:mm）；空 = 不自动生成。默认空 */
  dailyReportTime: string
  /** 检测卡/AI 建议卡闲置自动隐藏秒数；0=不自动隐藏（一直挂着）。默认 60 */
  screenSenseCardHideSec: number
  /** 悬浮助手闲置自动收起秒数；0=不自动收起。默认 60 */
  assistantAutoCloseSec: number
  /** 外观主题：跟随系统 / 浅色 / 深色。默认 system */
  theme: 'system' | 'light' | 'dark'
}

export interface FeishuStatus {
  status: 'disabled' | 'connecting' | 'connected' | 'error' | 'restart_required'
  detail: string
}

export interface ScanResult {
  status: 'suggested' | 'empty' | 'error'
  message: string
}

/** 工作记录：屏幕识别顺带的「在做什么」一句话时间线（供日报生成）。 */
export interface WorkRecord {
  id: string
  content: string
  /** 记录时的前台应用；手动扫描等场景为 null */
  app: string | null
  /** 任务级标签（模型归并，如「开发谷子助手」）；无法归属为 null */
  task: string | null
  createdAt: string
}

/** 某天某应用的前台使用时长（秒） */
export interface AppUsageEntry {
  app: string
  seconds: number
}

/** 前台应用切换事件（注意力分析素材；只存应用名与时刻） */
export interface AppSwitchRecord {
  ts: string
  fromApp: string | null
  toApp: string
}

/** 应用生产力分类：专注 / 中性 / 分心 */
export type AppCategory = 'productive' | 'neutral' | 'distracting'

/** 用户对某应用分类的手动覆盖（默认规则在 shared/attention.ts） */
export interface AppCategoryOverride {
  app: string
  category: AppCategory
}

/** AI 生成的工作日报 */
export interface ReportRecord {
  id: string
  /** 报告覆盖的日期 YYYY-MM-DD */
  day: string
  type: 'daily'
  title: string
  /** Markdown 正文 */
  content: string
  createdAt: string
}

/** 屏幕检测候选：云端解析结果的卡片 / 检测历史载荷形状。 */
export interface LocalExtraction {
  title: string
  /** YYYY-MM-DDTHH:mm；解不出为 null（绝不编造） */
  isoTime: string | null
  deadline: boolean
  belongsToUser: Belongs
  /** 命中信号词（填 DetectionRecord.hits） */
  hits: string[]
  confidence: number
  /** 派生：解析出了具体日期时间 → 决定是否主动弹卡 */
  strong: boolean
}
