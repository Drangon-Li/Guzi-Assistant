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

/** A macOS application selected for the History privacy blacklist. */
export interface HistoryAppSelection {
  bundleId: string
  name: string
  path: string
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
  /** 提醒提前量（分钟）；null = 跟随全局默认，负数 = 该任务关闭提醒 */
  remindOffsetMin: number | null
  /** 已提醒过的目标时刻（本地 ISO），提醒幂等键；改任务时间/提前量时复位 */
  remindedAt: string | null
  /** 稍后提醒到的时刻（本地 ISO） */
  snoozedUntil: string | null
  createdAt: string
  updatedAt: string
}

/** 提醒卡上的一条任务（主进程按 DueReminder + TaskRecord 组装） */
export interface ReminderCardItem {
  taskId: string
  title: string
  /** 事件真正发生的时刻（本地 ISO） */
  eventIso: string
  kind: 'ahead' | 'ontime' | 'catchup' | 'snooze'
  location: string | null
  notes: string[]
  priority: Priority
}

export interface ReminderPayload {
  items: ReminderCardItem[]
  /** 本轮超出单次展示上限、只在日程页可见的条数 */
  overflow: number
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
  /** 显示/隐藏主界面的全局快捷键 */
  mainWindowHotkey: string
  /** 开/关桌宠说话（聆听）模式的全局快捷键 */
  petVoiceHotkey: string
  /** 唤起快捷提问框（聚焦搜索式悬浮输入条）的全局快捷键 */
  quickAskHotkey: string
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
  /** 持续监控门控轮询间隔（秒），默认 5 */
  screenSenseIntervalSec: number
  /** 事件驱动截图门：前台 App/窗口变化时扫描，静止时仅按兜底间隔扫描。默认 true */
  screenSenseEventDriven: boolean
  /** 事件驱动模式的硬兜底截图间隔（秒），限制 30-60，默认 45 */
  screenSenseFallbackIntervalSec: number
  /** Hybrid History v2：语义完整时不截图，语义不足才按矩阵补 OCR；关闭即回 legacy。 */
  screenSenseHybridV2: boolean
  /** 应用排除名单（#40 隐私门）：这些 App 在前台时连截图都不做，默认空（不排除） */
  screenSenseExcludedApps: string[]
  /** @deprecated History include 名单，保留用于旧数据库兼容；新 UI 只使用黑名单。 */
  historyIncludedApps: string[]
  /** History 原生事件黑名单；选中的 macOS App 不写入 History。 */
  historyExcludedApps: HistoryAppSelection[]
  /** History 浏览器 host include 名单；空表示不按网站限制。只接受 host，不接受完整 URL。 */
  historyIncludedHosts: string[]
  /** History 浏览器 host exclude 名单；匹配域名及其子域名时抑制事件。 */
  historyExcludedHosts: string[]
  /** 持久化任务证据缩略图（#52/#53/#3）：默认 false；开启后加密落盘、任务完成即清 */
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
  /** 检测卡/AI 建议卡无操作自动忽略倒计时秒数（进度条走满即视为拒绝）；0=不倒计时（一直挂着）。默认 5 */
  screenSenseCardHideSec: number
  /** 悬浮助手闲置自动收起秒数；0=不自动收起。默认 60 */
  assistantAutoCloseSec: number
  /** 外观主题：跟随系统 / 浅色 / 深色。默认 system */
  theme: 'system' | 'light' | 'dark'
  /** 对外 MCP 服务：把任务/工作记录/日报能力暴露给用户自己的 AI 客户端。默认关 */
  mcpEnabled: boolean
  /** MCP 服务监听端口（仅绑定 127.0.0.1）。默认 38999 */
  mcpPort: number
  /** MCP Bearer token（设置页生成/重置；空 = 未生成，服务不会启动） */
  mcpToken: string
  /** 任务提醒总开关：到点/提前弹置顶提醒卡 + 桌宠气泡 + 系统通知。默认 true */
  taskReminderEnabled: boolean
  /** 任务提醒的全局默认提前量（分钟），0-1440；任务级 remindOffsetMin 可覆盖。默认 5 */
  taskReminderOffsetMin: number
  /** 用自己的 API 驱动解析，优先于内置托管服务（登录状态下也生效）。默认 false */
  useCustomModel: boolean
  /** 读图用的模型（含截图/图片的解析）；留空回落到 model。纯文本模型跑不了这类请求 */
  modelVision: string
  /** 助手对话用的模型；留空回落到 model */
  modelChat: string
  /** 剪贴板自动捕获：复制到疑似日程的内容时主动提示（macOS 15.4+ 的 detectPatterns 门控）。默认 true */
  clipWatchEnabled: boolean
  /** 待办识别专用扫描：内容型 App 前台时定期看一次屏幕文字抓待办（语义完整也不跳过）。默认 true */
  todoScanEnabled: boolean
  /** 待办识别扫描的最小间隔（秒），60-600。默认 180 */
  todoScanIntervalSec: number
  /** Computer History 2.0 原始事件双写；默认关闭，第一阶段不改变旧派生链路。 */
  historyV2Enabled: boolean
  /** Computer History 2.0 从 10 分钟摘要派生工作记录；需与 historyV2Enabled 同时开启。 */
  historyDerivedWorkEnabled: boolean
  /** 未来可选的文本捕获；默认关闭，第一阶段 schema 永不保存原始文本。 */
  historyCaptureText: boolean
}

export interface FeishuStatus {
  status: 'disabled' | 'connecting' | 'connected' | 'error' | 'restart_required'
  detail: string
}

export interface ScanResult {
  status: 'suggested' | 'empty' | 'error'
  message: string
}

export interface ScreenActivityStatus {
  eventDriven: boolean
  running: boolean
  paused: boolean
  observer: 'waiting' | 'healthy' | 'unavailable'
  observerDetail: string | null
  hybridV2: boolean
  collector: 'starting' | 'healthy' | 'degraded' | 'stopped'
  collectorDetail: string | null
  collectorRestartCount: number
  collectorDroppedEventCount: number
  collectorDeduplicatedEventCount: number
  collectorRateLimitedCount: number
  collectorBackoffBundleCount: number
  accessibility: 'available' | 'unavailable' | 'unknown'
  inputMonitoring: 'available' | 'unavailable' | 'unknown'
  /** 最近一次 native collector heartbeat；与普通活动事件时间分开，便于诊断无前台 App。 */
  lastHeartbeatAt: string | null
  semanticCoverage: number
  ocrFallbackCount: number
  ocrFallbackReasons: Record<string, number>
  recentTriggerReasons: string[]
  recentSummary: string | null
  latestEventCount: number
  latestMeaningfulEventCount: number
  latestSemanticCompleteCount: number
  latestSemanticPartialCount: number
  latestSemanticEmptyCount: number
  latestOcrEvidenceCount: number
  lastEventAt: string | null
  lastScanAt: string | null
  lastScanReason: 'event' | 'hard_fallback' | 'interval' | 'manual' | 'semantic_only' | null
  pendingEvent: boolean
  rawEventCount: number
  tenMinuteSegmentCount: number
  sixHourSegmentCount: number
  latestSummary: string | null
  workClassificationStatus: 'idle' | 'pending' | 'ok' | 'error' | 'unavailable'
  workClassificationSource: 'accessibility' | 'ocr' | null
  workClassificationAt: string | null
  workClassificationDetail: string | null
  workClassificationCount: number
  history: HistoryStoreHealth
}

export interface HistoryStoreHealth {
  enabled: boolean
  state: 'disabled' | 'starting' | 'healthy' | 'degraded' | 'stopped'
  currentSegmentId: string | null
  queueLength: number
  droppedCount: number
  suppressedCount: number
  invalidCount: number
  segmentCount: number
  lastWriteAt: string | null
  lastCleanupAt: string | null
  lastError: string | null
}

export interface ActivityHistorySegmentRecord {
  id: string
  bucketKind: '10m' | '6h'
  bucketStart: string
  bucketEnd: string
  firstEventAt: string
  lastEventAt: string
  eventCount: number
  meaningfulEventCount: number
  semanticCompleteCount: number
  semanticPartialCount: number
  semanticEmptyCount: number
  ocrEvidenceCount: number
  triggerReasons: string[]
  summary: string
  closed: boolean
  createdAt: string
  updatedAt: string
}

export interface OcrEvidenceRecord {
  id: string
  eventId: string | null
  segmentId: string | null
  occurredAt: string
  appName: string | null
  bundleId: string | null
  windowTitle: string | null
  semanticScore: number
  triggerReason: string
  redactionHits: string[]
  redactedText: string
  createdAt: string
}

export type WorkRecordSource = 'accessibility' | 'ocr'
export type WorkRecordDerivedBy = 'history' | 'legacy'

/** 工作记录：屏幕识别顺带的「在做什么」一句话时间线（供日报生成）。 */
export interface WorkRecord {
  id: string
  content: string
  /** 记录时的前台应用；手动扫描等场景为 null */
  app: string | null
  /** 任务级标签（模型归并，如「开发谷子助手」）；无法归属为 null */
  task: string | null
  /** 归类证据来源：Accessibility 浅层语义或 OCR 补证。 */
  source: WorkRecordSource
  /** 记录由 History 摘要派生，还是旧屏幕/OCR 路径写入。 */
  derivedBy: WorkRecordDerivedBy
  /** 关联的 10 分钟 History segment；旧记录为空。 */
  segmentId: string | null
  /** 工作活动的真实起止时间；旧记录回退到 createdAt。 */
  startAt: string
  endAt: string
  /** 摘要或归类置信度（0~1）。 */
  confidence: number
  /** 支撑该工作记录的事件/证据数量。 */
  evidenceCount: number
  /** 生成该记录时使用的摘要 hash；旧记录为空。 */
  summaryHash: string | null
  createdAt: string
}

/** History 10 分钟摘要派生工作记录的持久化输入。 */
export interface HistoryDerivedWorkRecordInput {
  segmentId: string
  content: string
  app: string | null
  task: string | null
  startAt: string
  endAt: string
  confidence: number
  evidenceCount: number
  summaryHash: string
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
