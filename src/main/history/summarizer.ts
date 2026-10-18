import { createHash } from 'node:crypto'
import { extractJson } from '../../shared/parsing.ts'
import { redactSensitive } from '../../shared/sensitive.ts'
import { ACTIVITY_RETENTION_MS, sanitizeWindowTitle, utcSixHourBucket } from '../../shared/activity-events.ts'
import {
  isMeaningfulHistoryEvent,
  type HistoryEvent
} from './event-schema.ts'
import {
  HistorySegmentStore,
  type HistorySegmentSnapshot,
  type HistorySegmentSummaryPatch
} from './event-store.ts'
import {
  SUMMARY_PROMPT_VERSION,
  buildSixHourSummaryPrompt,
  buildSummaryInput,
  buildTenMinuteSummaryPrompt
} from './summary-prompt.ts'
import type {
  HistorySummaryIndex,
  HistorySummaryModelStatus,
  HistorySummaryRecord
} from './summary-index.ts'

export type SummaryModelCall = (
  instructions: string,
  input: unknown[],
  signal?: AbortSignal
) => Promise<string>

export type TenMinuteSummaryHandler = (
  document: HistorySummaryDocument,
  sourceHash: string
) => void | Promise<void>

export interface SummaryAppStat {
  name: string
  bundleId: string | null
  eventCount: number
  meaningfulEventCount: number
}

export interface SummaryActivityStat {
  type: string
  count: number
}

export interface SummaryObservedDatum {
  occurredAt: string
  kind: string
  app: string | null
  window: string | null
  label: string | null
  command: string | null
}

export interface HistorySummaryDocument {
  schemaVersion: 1
  level: '10m' | '6h'
  id: string
  bucketStart: string
  bucketEnd: string
  startAt: string
  endAt: string
  timeRange: { startAt: string; endAt: string }
  apps: string[]
  appStats: SummaryAppStat[]
  windowThemes: string[]
  activityTypes: string[]
  activityTypeCounts: SummaryActivityStat[]
  taskClues: string[]
  confidence: number
  evidenceCount: number
  meaningfulEvidenceCount: number
  sourceSegmentId?: string
  sourceSegmentIds: string[]
  sourceSegments: string[]
  source: 'local' | 'model' | 'hybrid'
  summary: string
  /** Stable task/project label shared with work_records.task and task-focus aggregation. */
  focusTask?: string | null
  /** Conservative semantic interpretation shown as the primary History text. */
  focus?: string | null
  progress?: string | null
  outcome?: string | null
  resultEvidence?: string[]
  observedData: SummaryObservedDatum[]
  suppressedEventCount: number
  modelSupplement?: {
    activityType: string | null
    taskClues: string[]
    confidence: number
    focusTask?: string | null
    focus: string | null
    progress: string | null
    outcome: string | null
  }
}

export interface SummaryModelSupplement {
  summary: string | null
  focusTask: string | null
  focus: string | null
  progress: string | null
  outcome: string | null
  activityType: string | null
  taskClues: string[]
  confidence: number | null
}

export interface HistorySummarizerOptions {
  store: HistorySegmentStore
  summaryIndex: HistorySummaryIndex
  onTenMinuteSummary?: TenMinuteSummaryHandler
  now?: () => number
  modelCall?: SummaryModelCall
  /** Return false when no authenticated/direct model endpoint is configured. */
  onlineEnabled?: () => boolean
  eventAllowed?: (event: HistoryEvent) => boolean
  supplementalEvents?: (fromMs: number, toMs: number) => HistoryEvent[]
  policyKey?: () => string
  /** 已知任务名候选（10 分钟摘要的 focus_task 复用，避免同一任务被拆成多个近义名）。 */
  focusTaskCandidates?: () => string[]
  retryBaseMs?: number
  retryMaxMs?: number
}

export interface HistorySummaryStoreStarter {
  start(): Promise<void>
}

/**
 * Await store startup, then re-check the lifecycle barrier before allowing a
 * summary run to touch indexes, segment metadata, or derived work records.
 */
export async function runHistorySummaryAfterStoreStart<T>(
  store: HistorySummaryStoreStarter,
  canStart: () => boolean,
  run: () => Promise<T>
): Promise<T | null> {
  await store.start()
  if (!canStart()) return null
  return run()
}

export interface SummaryRunResult {
  /** Number of eligible summaries inspected during this run. */
  tenMinuteSummaries: number
  sixHourSummaries: number
  /** Number of summaries whose source/content/model state actually changed. */
  tenMinuteChanged: number
  sixHourChanged: number
  summariesPruned: number
  modelSuccesses: number
  modelFailures: number
}

function emptySummaryRun(): SummaryRunResult {
  return {
    tenMinuteSummaries: 0,
    sixHourSummaries: 0,
    tenMinuteChanged: 0,
    sixHourChanged: 0,
    summariesPruned: 0,
    modelSuccesses: 0,
    modelFailures: 0
  }
}

const MAX_APPS = 8
const MAX_ACTIVITY_TYPES = 12
const MAX_TASK_CLUES = 12
const MAX_OBSERVED_DATA = 24
const MAX_TEXT = 240
const SUMMARY_ALGORITHM_VERSION = SUMMARY_PROMPT_VERSION
const DEFAULT_RETRY_BASE_MS = 60_000
const DEFAULT_RETRY_MAX_MS = 6 * 60 * 60 * 1000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function cleanText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const redacted = redactSensitive(value).text
  const cleaned = sanitizeWindowTitle(redacted, max).replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, max) : null
}

function cleanShort(value: unknown, max = 120): string | null {
  return cleanText(value, max)
}

function uniqueStrings(values: readonly (string | null | undefined)[], limit: number): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const cleaned = cleanShort(value)
    if (!cleaned) continue
    const key = cleaned.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(cleaned)
    if (result.length >= limit) break
  }
  return result
}

function dominantString(values: readonly (string | null | undefined)[]): string | null {
  const entries = new Map<string, { value: string; count: number; first: number }>()
  values.forEach((value, index) => {
    const cleaned = cleanShort(value, 160)
    if (!cleaned) return
    const key = cleaned.toLocaleLowerCase()
    const current = entries.get(key)
    if (current) current.count += 1
    else entries.set(key, { value: cleaned, count: 1, first: index })
  })
  return [...entries.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0]?.value ?? null
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function summarySourceHash(value: unknown): string {
  return createHash('sha256').update(stableValue(value)).digest('hex')
}

function eventTimestamp(event: HistoryEvent): number {
  const value = Date.parse(event.occurred_at)
  return Number.isFinite(value) ? value : 0
}

function eventFingerprint(event: HistoryEvent): Record<string, unknown> {
  return {
    id: event.id,
    occurredAt: event.occurred_at,
    kind: event.kind,
    app: event.app_name,
    bundle: event.bundle_id,
    window: event.window_title,
    host: event.url_host,
    role: event.target_role,
    label: event.target_label,
    command: event.command,
    modifiers: event.modifiers,
    inputLength: event.input_length
  }
}

function sourceFingerprint(snapshot: HistorySegmentSnapshot): Record<string, unknown> {
  return {
    algorithmVersion: SUMMARY_ALGORITHM_VERSION,
    id: snapshot.metadata.id,
    bucketStart: snapshot.metadata.bucketStart,
    bucketEnd: snapshot.metadata.bucketEnd,
    suppressedEventCount: snapshot.metadata.suppressedEventCount,
    events: [...snapshot.events].sort((a, b) => eventTimestamp(a) - eventTimestamp(b) || a.id.localeCompare(b.id)).map(eventFingerprint)
  }
}

interface SemanticNarrative {
  focusTask: string | null
  focus: string
  progress: string
  outcome: string | null
  summary: string
}

const FOCUS_RULES: readonly { pattern: RegExp; verb: string }[] = [
  { pattern: /code|vscode|xcode|terminal|git|\.tsx?|\.jsx?|\.py|\.rs|代码|开发|编译|调试/i, verb: '编写或调试代码' },
  { pattern: /notion|word|pages|docs?|markdown|paper|论文|文档|笔记|章节|报告/i, verb: '编辑或整理文档' },
  { pattern: /chrome|safari|firefox|browser|http|网页|搜索|资料|查找/i, verb: '浏览网页并查找资料' },
  { pattern: /slack|discord|wechat|微信|邮件|mail|chat|消息|沟通/i, verb: '处理消息并进行沟通' },
  { pattern: /figma|sketch|photoshop|design|设计|原型|素材/i, verb: '设计或编辑视觉素材' },
  { pattern: /excel|numbers|spreadsheet|csv|表格|数据|分析/i, verb: '整理表格或分析数据' },
  { pattern: /calendar|reminder|schedule|日程|会议|任务/i, verb: '安排日程或整理任务' }
]

function subjectCandidate(values: readonly (string | null | undefined)[], apps: readonly string[]): string | null {
  const appNames = new Set(apps.map((app) => app.toLocaleLowerCase()))
  const generic = /^(new window|untitled|window|document|pointer_action|key_down|key_up|button|text field|unknown|none|input|click|selection|submit|send)$/i
  for (const value of [...values].reverse()) {
    const cleaned = cleanShort(value, 100)
    if (!cleaned || cleaned.length < 2 || generic.test(cleaned) || appNames.has(cleaned.toLocaleLowerCase())) continue
    if (/^(https?:\/\/|www\.)/i.test(cleaned)) continue
    return cleaned
  }
  return null
}

function dominantVerb(events: readonly HistoryEvent[], apps: readonly string[], clues: readonly string[]): string {
  const signal = [...apps, ...clues].join(' ')
  const rule = FOCUS_RULES.find((item) => item.pattern.test(signal))
  if (rule) return rule.verb
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1)
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (dominant === 'input_activity') return '编辑内容'
  if (dominant === 'selection_changed') return '查看并整理内容'
  if (dominant === 'click' || dominant === 'drag' || dominant === 'shortcut') return '操作当前界面'
  return '处理当前内容'
}

function progressFor(events: readonly HistoryEvent[]): { progress: string; outcome: string | null } {
  if (!events.some(isMeaningfulHistoryEvent)) return { progress: '暂无足够证据判断进展', outcome: null }
  if (events.some((event) => event.kind === 'submit' || /submit|send|done|完成|提交/i.test(event.command ?? ''))) {
    return { progress: '出现提交或发送操作，结果待确认', outcome: null }
  }
  if (events.some((event) => ['input_activity', 'selection_changed', 'click', 'drag', 'shortcut'].includes(event.kind))) {
    return { progress: '持续进行中', outcome: null }
  }
  return { progress: '正在查看和整理', outcome: null }
}

function narrativeFor(
  level: '10m' | '6h',
  events: readonly HistoryEvent[],
  apps: readonly string[],
  clues: readonly string[]
): SemanticNarrative {
  const subject = subjectCandidate(clues, apps)
  const verb = dominantVerb(events, apps, clues)
  const focus = subject ? `围绕「${subject}」${verb}` : verb
  const { progress, outcome } = progressFor(events)
  const prefix = level === '6h' ? '这一时段主要' : '主要'
  return {
    // 本地规则只能看到窗口标题/线索，产不出稳定任务名；focusTask 一律交给模型补充，
    // 否则窗口标题（「微信 (窗口)」、用户名等）会被当成任务写进专注统计
    focusTask: null,
    focus,
    progress,
    outcome,
    summary: `${prefix}${focus}；${progress}${outcome ? `，${outcome}` : ''}`.slice(0, MAX_TEXT)
  }
}

function composeSummary(level: '10m' | '6h', focus: string, progress: string | null, outcome: string | null, fallback: string): string {
  const safeFocus = (cleanText(focus, 160) ?? fallback).replace(/^这一时段主要|^主要/, '') || fallback
  const prefix = level === '6h' ? '这一时段主要' : '主要'
  const parts = [`${prefix}${safeFocus}`]
  const progressText = progress ? cleanText(progress, 80) : null
  const outcomeText = outcome ? cleanText(outcome, 100) : null
  if (progressText) parts.push(`进展：${progressText}`)
  if (outcomeText) parts.push(`结果线索：${outcomeText}`)
  return parts.join('；').slice(0, MAX_TEXT)
}

function appStats(events: readonly HistoryEvent[]): SummaryAppStat[] {
  const map = new Map<string, SummaryAppStat>()
  for (const event of events) {
    const name = cleanShort(event.app_name, 80)
    if (!name) continue
    const bundleId = cleanShort(event.bundle_id, 160)
    const key = `${bundleId ?? ''}\u0000${name.toLocaleLowerCase()}`
    const current = map.get(key) ?? { name, bundleId, eventCount: 0, meaningfulEventCount: 0 }
    current.eventCount += 1
    if (isMeaningfulHistoryEvent(event)) current.meaningfulEventCount += 1
    map.set(key, current)
  }
  return [...map.values()]
    .sort((a, b) => b.meaningfulEventCount - a.meaningfulEventCount || b.eventCount - a.eventCount || a.name.localeCompare(b.name))
    .slice(0, MAX_APPS)
}

function activityStats(events: readonly HistoryEvent[]): SummaryActivityStat[] {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_ACTIVITY_TYPES)
    .map(([type, count]) => ({ type, count }))
}

function taskClues(events: readonly HistoryEvent[]): string[] {
  const clues: (string | null | undefined)[] = []
  for (const event of events) {
    clues.push(event.target_label, event.window_title, event.command)
    if (event.url_host) clues.push(`网站 ${event.url_host}`)
  }
  return uniqueStrings(clues, MAX_TASK_CLUES)
}

function windowThemes(events: readonly HistoryEvent[]): string[] {
  return uniqueStrings(events.flatMap((event) => [event.window_title, event.target_label]), MAX_TASK_CLUES)
}

function observedData(events: readonly HistoryEvent[]): SummaryObservedDatum[] {
  const ordered = [...events]
    .filter((event) => isMeaningfulHistoryEvent(event) || event.kind === 'window_changed')
    .sort((a, b) => eventTimestamp(a) - eventTimestamp(b) || a.id.localeCompare(b.id))
  // Include the end of a busy interval, where completion/submission evidence often appears.
  const selected = ordered.length <= MAX_OBSERVED_DATA ? ordered
    : Array.from({ length: MAX_OBSERVED_DATA }, (_, i) => ordered[Math.round(i * (ordered.length - 1) / (MAX_OBSERVED_DATA - 1))])
  return selected
    .map((event) => ({
      occurredAt: event.occurred_at,
      kind: event.kind,
      app: cleanShort(event.app_name, 80),
      window: cleanShort(event.window_title, 120),
      label: cleanShort(event.target_label, event.kind === 'screen_changed' && event.source === 'fallback' ? 1000 : 120),
      command: cleanShort(event.command, 80)
    }))
}

// Result assertions must be copied from a visible result, never inferred from
// a command, a button label, a task name, or the act of editing/submitting.
function hasResultClaim(text: string): boolean {
  const affirmative = text.replace(/(?:尚未|未能|未|没有|无法|不能|不代表|不证明|不意味着|正在|待|计划|准备|尝试)(?:全部|完全)?(?:完成|成功|通过)|(?:尚无|暂无|没有|未有)(?:结果|结论)|\b(?:not|never)\s+(?:completed?|finished|succeeded|passed)\b/gi, '')
  return /完成|完毕|结束|成功|(?:测试|检查|校验|验证|编译|构建|审核|验收)(?:已|已经|全部|均)*通过|通过(?:了)?(?:测试|检查|校验|验证|编译|构建|审核|验收)|顺利通过|通过(?=$|[，。；,;!！])|已(?:经)?(?:修复|解决|交付|提交|保存|实现|验证|合并|部署)|(?:修复|解决|实现|交付|提交|保存)了|(?:跑|执行|运行|编译|构建)完|\b(?:completed?|finished|succeeded|successful|passed|done|resolved|fixed|delivered)\b/i.test(affirmative)
}

function resultEvidenceFor(events: readonly HistoryEvent[]): string[] {
  const evidence: string[] = []
  for (const event of events) {
    if (event.kind !== 'screen_changed' && event.kind !== 'ax_attribute_changed') continue
    for (const clause of (event.target_label ?? '').split(/[\n。；;]/)) {
      const text = cleanShort(clause, 120)
      if (!text || !hasResultClaim(text)) continue
      if (!/(?:测试|构建|编译|运行|保存|提交|发布)(?:结果|状态)|(?:测试|构建|编译)(?:已|全部|均)?(?:通过|成功|完成)|\b(?:tests?\s+(?:results?|passed)|build\s+(?:succeeded|successful)|\d+\s+(?:tests?\s+)?passed)\b/i.test(text)) continue
      if (/(?:请|需要|计划|准备|预计|希望|如果|假设|尝试|正在|未|不通过|不成功|不代表|不意味着|尚无|暂无|没有|失败|待确认|通过后|完成后|成功后|console\.|assert\b|expect\b|["'`?？])|\b(?:not|pending|expected|if|[1-9]\d*\s+failed)\b/i.test(text)) continue
      evidence.push(text)
    }
  }
  return uniqueStrings(evidence, MAX_TASK_CLUES)
}

function confidenceFor(events: readonly HistoryEvent[], apps: readonly SummaryAppStat[], clues: readonly string[]): number {
  if (!events.length) return 0.15
  const meaningful = events.filter(isMeaningfulHistoryEvent).length
  const signal = meaningful / events.length
  const metadata = Math.min(1, (apps.length > 0 ? 0.35 : 0) + (clues.length > 0 ? 0.35 : 0))
  return Number(clamp(0.25 + signal * 0.45 + metadata * 0.2, 0.15, 0.95).toFixed(3))
}

export function summarizeTenMinuteSegment(snapshot: HistorySegmentSnapshot): {
  document: HistorySummaryDocument
  sourceHash: string
} {
  const metadata = snapshot.metadata
  const events = [...snapshot.events].sort((a, b) => eventTimestamp(a) - eventTimestamp(b) || a.id.localeCompare(b.id))
  const firstAt = events[0]?.occurred_at ?? metadata.bucketStart
  const lastAt = events.at(-1)?.occurred_at ?? metadata.bucketEnd
  const appsData = appStats(events)
  const activities = activityStats(events)
  const clues = taskClues(events)
  const themes = windowThemes(events)
  const confidence = confidenceFor(events, appsData, clues)
  const narrative = narrativeFor('10m', events, appsData.map((item) => item.name), clues)
  const sourceSegmentIds = [metadata.id]
  const document: HistorySummaryDocument = {
    schemaVersion: 1,
    level: '10m',
    id: metadata.id,
    bucketStart: metadata.bucketStart,
    bucketEnd: metadata.bucketEnd,
    startAt: firstAt,
    endAt: lastAt,
    timeRange: { startAt: firstAt, endAt: lastAt },
    apps: appsData.map((item) => item.name),
    appStats: appsData,
    windowThemes: themes,
    activityTypes: activities.map((item) => item.type),
    activityTypeCounts: activities,
    taskClues: clues,
    confidence,
    evidenceCount: events.length,
    meaningfulEvidenceCount: events.filter(isMeaningfulHistoryEvent).length,
    sourceSegmentId: metadata.id,
    sourceSegmentIds,
    sourceSegments: sourceSegmentIds,
    source: 'local',
    summary: narrative.summary,
    focusTask: narrative.focusTask,
    focus: narrative.focus,
    progress: narrative.progress,
    outcome: narrative.outcome,
    resultEvidence: resultEvidenceFor(events),
    observedData: observedData(events),
    suppressedEventCount: metadata.suppressedEventCount
  }
  return { document, sourceHash: summarySourceHash(sourceFingerprint(snapshot)) }
}

export function summarizeSixHourSummaries(summaries: readonly HistorySummaryDocument[], id: string, bucketStart: string, bucketEnd: string): {
  document: HistorySummaryDocument
  sourceHash: string
} {
  const ordered = [...summaries].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id))
  const sourceSegmentIds = [...new Set(ordered.flatMap((summary) => summary.sourceSegmentIds))].slice(0, 128)
  const apps = new Map<string, SummaryAppStat>()
  const activity = new Map<string, number>()
  const clues: string[] = []
  const themes: string[] = []
  let evidenceCount = 0
  let meaningfulEvidenceCount = 0
  let suppressedEventCount = 0
  let weightedConfidence = 0
  let weight = 0
  for (const summary of ordered) {
    evidenceCount += summary.evidenceCount
    meaningfulEvidenceCount += summary.meaningfulEvidenceCount
    suppressedEventCount += summary.suppressedEventCount
    const summaryWeight = Math.max(1, summary.evidenceCount)
    weightedConfidence += summary.confidence * summaryWeight
    weight += summaryWeight
    for (const stat of summary.appStats) {
      const key = `${stat.bundleId ?? ''}\u0000${stat.name.toLocaleLowerCase()}`
      const current = apps.get(key) ?? { ...stat, eventCount: 0, meaningfulEventCount: 0 }
      current.eventCount += stat.eventCount
      current.meaningfulEventCount += stat.meaningfulEventCount
      apps.set(key, current)
    }
    for (const stat of summary.activityTypeCounts)
      activity.set(stat.type, (activity.get(stat.type) ?? 0) + stat.count)
    clues.push(...summary.taskClues)
    themes.push(...summary.windowThemes)
  }
  const appStatsData = [...apps.values()]
    .sort((a, b) => b.meaningfulEventCount - a.meaningfulEventCount || b.eventCount - a.eventCount || a.name.localeCompare(b.name))
    .slice(0, MAX_APPS)
  const activityStatsData = [...activity.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_ACTIVITY_TYPES)
    .map(([type, count]) => ({ type, count }))
  const taskCluesData = uniqueStrings(clues, MAX_TASK_CLUES)
  const windowThemesData = uniqueStrings(themes, MAX_TASK_CLUES)
  const confidence = Number(clamp(weight ? weightedConfidence / weight : 0.15, 0.15, 0.95).toFixed(3))
  const focus = dominantString(ordered.map((summary) => summary.focus)) ?? '处理当前内容'
  const focusTask = dominantString(ordered.map((summary) => summary.focusTask ?? null))
  const progress = ordered.some((summary) => summary.progress === '持续进行中')
    ? '持续进行中'
    : ordered.find((summary) => summary.progress)?.progress ?? '暂无足够证据判断进展'
  const outcome = ordered.find((summary) => summary.outcome)?.outcome ?? null
  const document: HistorySummaryDocument = {
    schemaVersion: 1,
    level: '6h',
    id,
    bucketStart,
    bucketEnd,
    startAt: bucketStart,
    endAt: bucketEnd,
    timeRange: { startAt: bucketStart, endAt: bucketEnd },
    apps: appStatsData.map((item) => item.name),
    appStats: appStatsData,
    windowThemes: windowThemesData,
    activityTypes: activityStatsData.map((item) => item.type),
    activityTypeCounts: activityStatsData,
    taskClues: taskCluesData,
    confidence,
    evidenceCount,
    meaningfulEvidenceCount,
    sourceSegmentIds,
    sourceSegments: sourceSegmentIds,
    source: 'local',
    summary: composeSummary('6h', focus, progress, outcome, '处理当前内容'),
    focusTask,
    focus,
    progress,
    outcome,
    resultEvidence: uniqueStrings(ordered.flatMap((summary) => summary.resultEvidence ?? []), MAX_TASK_CLUES),
    observedData: ordered.slice(0, MAX_OBSERVED_DATA).map((summary) => ({
      occurredAt: summary.startAt,
      kind: '10m_summary',
      app: summary.apps.slice(0, 3).join(', ') || null,
      window: summary.summary,
      label: summary.taskClues.slice(0, 3).join('、') || null,
      command: summary.sourceSegmentIds[0] ?? null
    })),
    suppressedEventCount
  }
  return {
    document,
    sourceHash: summarySourceHash({
      algorithmVersion: SUMMARY_ALGORITHM_VERSION,
      level: '6h',
      bucketStart,
      bucketEnd,
      summaries: ordered.map((summary) => ({ id: summary.id, sourceSegmentIds: summary.sourceSegmentIds, summaryHash: summarySourceHash(summary) }))
    })
  }
}

export function parseModelSupplement(raw: string): SummaryModelSupplement {
  const parsed = extractJson(raw)
  const taskClues = Array.isArray(parsed.task_clues)
    ? uniqueStrings(parsed.task_clues.filter((item): item is string => typeof item === 'string'), MAX_TASK_CLUES)
    : []
  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? clamp(parsed.confidence, 0, 1)
      : null
  return {
    summary: cleanText(parsed.summary, MAX_TEXT),
    focusTask: cleanShort(parsed.focus_task, 100),
    focus: cleanShort(parsed.focus, 160),
    progress: cleanShort(parsed.progress, 100),
    outcome: cleanShort(parsed.outcome, 120),
    activityType: cleanShort(parsed.activity_type, 80),
    taskClues,
    confidence
  }
}

function mergeModelSupplement(document: HistorySummaryDocument, rawSupplement: SummaryModelSupplement): HistorySummaryDocument {
  const evidence = new Set(document.resultEvidence ?? [])
  const supported = (value: string | null): string | null =>
    value && hasResultClaim(value) && !evidence.has(value) ? null : value
  // Reject the whole unsupported claim instead of rewriting "completed" to
  // "ongoing", which would retain an invented scope or outcome.
  const supplement: SummaryModelSupplement = {
    ...rawSupplement,
    summary: supported(rawSupplement.summary),
    focusTask: supported(rawSupplement.focusTask),
    focus: supported(rawSupplement.focus),
    progress: supported(rawSupplement.progress),
    outcome: supported(rawSupplement.outcome),
    taskClues: rawSupplement.taskClues.filter((clue) => supported(clue) !== null)
  }
  const modelSummary = supplement.summary
  const modelConfidence = supplement.confidence == null ? document.confidence : supplement.confidence
  const confidence = Number(clamp((document.confidence + modelConfidence) / 2, document.confidence, 0.95).toFixed(3))
  const focus = supplement.focus ?? document.focus ?? '处理当前内容'
  const focusTask = supplement.focusTask ?? document.focusTask ?? null
  const progress = supplement.progress ?? document.progress ?? null
  const outcome = supplement.outcome ?? document.outcome ?? null
  const semanticText = modelSummary
    ? composeSummary(document.level, modelSummary, progress, outcome, document.summary)
    : composeSummary(document.level, focus, progress, outcome, document.summary)
  return {
    ...document,
    source: 'hybrid',
    summary: semanticText,
    focusTask,
    focus,
    progress,
    outcome,
    taskClues: uniqueStrings([...supplement.taskClues, ...document.taskClues], MAX_TASK_CLUES),
    confidence,
    modelSupplement: {
      activityType: supplement.activityType,
      taskClues: supplement.taskClues,
      confidence: modelConfidence,
      focusTask: supplement.focusTask,
      focus: supplement.focus,
      progress: supplement.progress,
      outcome: supplement.outcome
    }
  }
}

/** Parse a persisted summary into the bounded document shape used by queries. */
export function parseHistorySummaryDocument(raw: string | null | undefined): HistorySummaryDocument | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<HistorySummaryDocument>
    if (
      value.schemaVersion !== 1 ||
      (value.level !== '10m' && value.level !== '6h') ||
      typeof value.id !== 'string' ||
      typeof value.summary !== 'string' ||
      !Array.isArray(value.sourceSegmentIds)
    ) return null
    return {
      ...value,
      bucketStart: typeof value.bucketStart === 'string' ? value.bucketStart : value.startAt,
      bucketEnd: typeof value.bucketEnd === 'string' ? value.bucketEnd : value.endAt,
      timeRange: value.timeRange ?? { startAt: value.startAt, endAt: value.endAt },
      apps: Array.isArray(value.apps) ? value.apps : [],
      appStats: Array.isArray(value.appStats) ? value.appStats : [],
      windowThemes: Array.isArray(value.windowThemes) ? value.windowThemes : [],
      activityTypes: Array.isArray(value.activityTypes) ? value.activityTypes : [],
      activityTypeCounts: Array.isArray(value.activityTypeCounts) ? value.activityTypeCounts : [],
      taskClues: Array.isArray(value.taskClues) ? value.taskClues : [],
      focusTask: cleanShort(value.focusTask, 100),
      confidence: typeof value.confidence === 'number' ? value.confidence : 0.15,
      evidenceCount: typeof value.evidenceCount === 'number' ? value.evidenceCount : 0,
      meaningfulEvidenceCount: typeof value.meaningfulEvidenceCount === 'number' ? value.meaningfulEvidenceCount : 0,
      sourceSegmentIds: value.sourceSegmentIds,
      sourceSegments: Array.isArray(value.sourceSegments) ? value.sourceSegments : value.sourceSegmentIds,
      source: value.source === 'model' || value.source === 'hybrid' ? value.source : 'local',
      focus: cleanShort(value.focus, 160),
      progress: cleanShort(value.progress, 100),
      outcome: cleanShort(value.outcome, 120),
      observedData: Array.isArray(value.observedData) ? value.observedData : [],
      suppressedEventCount: typeof value.suppressedEventCount === 'number' ? value.suppressedEventCount : 0
    } as HistorySummaryDocument
  } catch {
    return null
  }
}

const parseDocument = parseHistorySummaryDocument

function nowIso(now: () => number): string {
  return new Date(now()).toISOString()
}

function retryAt(nowMs: number, attemptCount: number, baseMs: number, maxMs: number): string {
  const delay = Math.min(maxMs, baseMs * 2 ** Math.max(0, attemptCount - 1))
  return new Date(nowMs + delay).toISOString()
}

function modelStatusFor(record: HistorySummaryRecord | null): HistorySummaryModelStatus {
  return record?.modelStatus ?? 'idle'
}

function patchFor(document: HistorySummaryDocument): HistorySegmentSummaryPatch {
  return { status: 'ready', text: document.summary.slice(0, MAX_TEXT), json: JSON.stringify(document) }
}

async function defaultModelCall(instructions: string, input: unknown[], signal?: AbortSignal): Promise<string> {
  const { callModel } = await import('../parser.ts')
  return callModel(instructions, input, 'parse_text', signal)
}

export class HistorySummarizer {
  private readonly store: HistorySegmentStore
  private readonly summaryIndex: HistorySummaryIndex
  private readonly onTenMinuteSummary: TenMinuteSummaryHandler | null
  private readonly now: () => number
  private readonly modelCall: SummaryModelCall
  private readonly onlineEnabled: () => boolean
  private readonly eventAllowed: (event: HistoryEvent) => boolean
  private readonly supplementalEvents: (fromMs: number, toMs: number) => HistoryEvent[]
  private readonly policyKey: () => string
  private runPolicyKey = ''
  private readonly focusTaskCandidates: () => string[]
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private active: Promise<SummaryRunResult> | null = null
  private abortController: AbortController | null = null
  private generation = 0
  private closed = false

  constructor(options: HistorySummarizerOptions) {
    this.store = options.store
    this.summaryIndex = options.summaryIndex
    this.onTenMinuteSummary = options.onTenMinuteSummary ?? null
    this.now = options.now ?? Date.now
    this.modelCall = options.modelCall ?? defaultModelCall
    this.onlineEnabled = options.onlineEnabled ?? (() => true)
    this.eventAllowed = options.eventAllowed ?? (() => true)
    this.supplementalEvents = options.supplementalEvents ?? (() => [])
    this.policyKey = options.policyKey ?? (() => '')
    this.focusTaskCandidates = options.focusTaskCandidates ?? (() => [])
    this.retryBaseMs = Math.max(1_000, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
  }

  process(nowMs = this.now()): Promise<SummaryRunResult> {
    if (this.closed) return Promise.resolve(emptySummaryRun())
    if (this.active) return this.active
    const generation = this.generation
    this.runPolicyKey = this.policyKey()
    this.active = this.run(nowMs, generation).finally(() => {
      this.active = null
      this.abortController = null
    })
    return this.active
  }

  /** Invalidate the current run before a destructive History mutation. */
  async invalidateAndWait(): Promise<void> {
    this.generation += 1
    this.abortController?.abort()
    await this.active?.catch(() => {})
  }

  async close(): Promise<void> {
    this.closed = true
    await this.invalidateAndWait()
    this.active = null
  }

  private isCurrent(generation: number): boolean {
    return !this.closed && this.generation === generation && this.runPolicyKey === this.policyKey()
  }

  private async run(nowMs: number, generation: number): Promise<SummaryRunResult> {
    const result = emptySummaryRun()
    if (!this.isCurrent(generation)) return result
    result.summariesPruned = this.pruneExpiredSummaries(nowMs)
    const cutoff = nowMs - ACTIVITY_RETENTION_MS
    const snapshots = await this.store.listSegmentSnapshots()
    if (!this.isCurrent(generation)) return result
    for (const snapshot of snapshots) {
      if (!this.isCurrent(generation)) return result
      const bucketEnd = Date.parse(snapshot.metadata.bucketEnd)
      if (!Number.isFinite(bucketEnd) || bucketEnd <= cutoff || bucketEnd > nowMs) continue
      result.tenMinuteSummaries += 1
      const processed = await this.processTenMinute(snapshot, nowMs, result, generation)
      if (processed?.changed) result.tenMinuteChanged += 1
    }
    if (!this.isCurrent(generation)) return result
    await this.processSixHour(nowMs, result, generation)
    return result
  }

  private async processTenMinute(
    snapshot: HistorySegmentSnapshot,
    nowMs: number,
    result: SummaryRunResult,
    generation: number
  ): Promise<{ document: HistorySummaryDocument; record: HistorySummaryRecord; changed: boolean } | null> {
    if (!this.isCurrent(generation)) return null
    const extra = this.supplementalEvents(Date.parse(snapshot.metadata.bucketStart), Date.parse(snapshot.metadata.bucketEnd))
    const allowedSnapshot = { ...snapshot, events: [...snapshot.events, ...extra].filter(this.eventAllowed) }
    const { document: localDocument, sourceHash } = summarizeTenMinuteSegment(allowedSnapshot)
    const existing = this.summaryIndex.get(snapshot.metadata.id)
    let document = existing?.sourceHash === sourceHash ? parseDocument(existing.summaryJson) : null
    let changed = false
    if (!document) {
      document = localDocument
      const record = this.baseRecord(document, sourceHash, existing, nowMs)
      this.summaryIndex.upsert(record)
      changed = true
      await this.store.updateSummary(document.id, patchFor(document))
      if (!this.isCurrent(generation)) return null
    } else {
      const patch = patchFor(document)
      if (
        snapshot.metadata.summaryStatus !== patch.status ||
        snapshot.metadata.summaryText !== patch.text ||
        snapshot.metadata.summaryJson !== patch.json
      ) {
        await this.store.updateSummary(document.id, patch)
        changed = true
        if (!this.isCurrent(generation)) return null
      }
    }

    let record = this.summaryIndex.get(snapshot.metadata.id) ?? this.baseRecord(document, sourceHash, existing, nowMs)
    if (this.isCurrent(generation) && document.meaningfulEvidenceCount > 0 && this.shouldAttemptModel(record, nowMs)) {
      try {
        const supplement = await this.callSummaryModel('10m', document, nowMs)
        if (!this.isCurrent(generation)) return null
        document = mergeModelSupplement(document, supplement)
        record = {
          ...record,
          status: 'ready',
          summaryText: document.summary,
          summaryJson: JSON.stringify(document),
          modelStatus: 'ready',
          attemptCount: record.attemptCount,
          nextRetryAt: null,
          lastError: null,
          updatedAt: nowIso(this.now)
        }
        this.summaryIndex.upsert(record)
        await this.store.updateSummary(document.id, patchFor(document))
        if (!this.isCurrent(generation)) return null
        result.modelSuccesses += 1
        changed = true
      } catch (error) {
        if (!this.isCurrent(generation)) return null
        record = this.failedModelRecord(record, nowMs, error)
        this.summaryIndex.upsert(record)
        result.modelFailures += 1
        changed = true
      }
    }
    if (!this.isCurrent(generation)) return null
    await this.onTenMinuteSummary?.(document, sourceHash)
    if (!this.isCurrent(generation)) return null
    return { document, record, changed }
  }

  private async processSixHour(nowMs: number, result: SummaryRunResult, generation: number): Promise<void> {
    // Deliberately read only summary records here. Raw JSONL is never consulted
    // while producing a 6-hour rollup.
    const cutoff = nowMs - ACTIVITY_RETENTION_MS
    const tenMinuteRecords = this.summaryIndex.list('10m')
    const groups = new Map<string, { bucketStart: string; bucketEnd: string; summaries: HistorySummaryDocument[] }>()
    for (const record of tenMinuteRecords) {
      if (!this.isCurrent(generation)) return
      const bucketEnd = Date.parse(record.bucketEnd)
      if (record.status !== 'ready' || !Number.isFinite(bucketEnd) || bucketEnd <= cutoff || bucketEnd > nowMs) continue
      const document = parseDocument(record.summaryJson)
      if (!document || document.level !== '10m') continue
      const bucketStart = Date.parse(record.bucketStart)
      if (!Number.isFinite(bucketStart)) continue
      const bucket = utcSixHourBucket(bucketStart)
      const group = groups.get(bucket.startIso) ?? { bucketStart: bucket.startIso, bucketEnd: bucket.endIso, summaries: [] }
      group.summaries.push(document)
      groups.set(bucket.startIso, group)
    }
    for (const group of groups.values()) {
      if (!this.isCurrent(generation)) return
      const groupEnd = Date.parse(group.bucketEnd)
      if (!Number.isFinite(groupEnd) || groupEnd <= cutoff || groupEnd > nowMs || !group.summaries.length) continue
      result.sixHourSummaries += 1
      const id = `history-6h-${group.bucketStart}`
      const { document: localDocument, sourceHash } = summarizeSixHourSummaries(group.summaries, id, group.bucketStart, group.bucketEnd)
      const existing = this.summaryIndex.get(id)
      let document = existing?.sourceHash === sourceHash ? parseDocument(existing.summaryJson) : null
      let changed = false
      if (!document) {
        document = localDocument
        this.summaryIndex.upsert(this.baseRecord(document, sourceHash, existing, nowMs))
        changed = true
      }
      let record = this.summaryIndex.get(id) ?? this.baseRecord(document, sourceHash, existing, nowMs)
      if (this.isCurrent(generation) && document.meaningfulEvidenceCount > 0 && this.shouldAttemptModel(record, nowMs)) {
        try {
          const supplement = await this.callSummaryModel('6h', document, nowMs)
          if (!this.isCurrent(generation)) return
          document = mergeModelSupplement(document, supplement)
          record = {
            ...record,
            status: 'ready',
            summaryText: document.summary,
            summaryJson: JSON.stringify(document),
            modelStatus: 'ready',
            nextRetryAt: null,
            lastError: null,
            updatedAt: nowIso(this.now)
          }
          this.summaryIndex.upsert(record)
          if (!this.isCurrent(generation)) return
          result.modelSuccesses += 1
          changed = true
        } catch (error) {
          if (!this.isCurrent(generation)) return
          this.summaryIndex.upsert(this.failedModelRecord(record, nowMs, error))
          result.modelFailures += 1
          changed = true
        }
      }
      if (changed) result.sixHourChanged += 1
    }
  }

  private pruneExpiredSummaries(nowMs: number): number {
    const cutoff = nowMs - ACTIVITY_RETENTION_MS
    let removed = 0
    for (const record of this.summaryIndex.list()) {
      const bucketEnd = Date.parse(record.bucketEnd)
      if (Number.isFinite(bucketEnd) && bucketEnd <= cutoff) {
        this.summaryIndex.remove(record.id)
        removed += 1
      }
    }
    return removed
  }

  private baseRecord(
    document: HistorySummaryDocument,
    sourceHash: string,
    existing: HistorySummaryRecord | null,
    nowMs: number
  ): HistorySummaryRecord {
    const createdAt = existing?.createdAt ?? new Date(nowMs).toISOString()
    return {
      id: document.id,
      level: document.level,
      bucketStart: document.bucketStart ?? document.startAt,
      bucketEnd: document.bucketEnd ?? document.endAt,
      sourceSegmentIds: document.sourceSegmentIds,
      sourceHash,
      status: 'ready',
      summaryText: document.summary,
      summaryJson: JSON.stringify(document),
      modelStatus: existing?.sourceHash === sourceHash ? modelStatusFor(existing) : 'idle',
      attemptCount: existing?.sourceHash === sourceHash ? existing.attemptCount : 0,
      nextRetryAt: existing?.sourceHash === sourceHash ? existing.nextRetryAt : null,
      lastError: existing?.sourceHash === sourceHash ? existing.lastError : null,
      createdAt,
      updatedAt: new Date(nowMs).toISOString()
    }
  }

  private shouldAttemptModel(record: HistorySummaryRecord, nowMs: number): boolean {
    if (!this.onlineEnabled() || record.modelStatus === 'ready') return false
    if (record.nextRetryAt && Date.parse(record.nextRetryAt) > nowMs) return false
    return true
  }

  private async callSummaryModel(level: '10m' | '6h', document: HistorySummaryDocument, nowMs: number): Promise<SummaryModelSupplement> {
    if (this.closed) throw new Error('summary worker closed')
    const controller = new AbortController()
    this.abortController = controller
    const inputDocument = {
      level,
      timeRange: document.timeRange,
      apps: document.appStats,
      windowThemes: document.windowThemes,
      activityTypes: document.activityTypeCounts,
      taskClues: document.taskClues,
      focusTask: document.focusTask,
      focus: document.focus,
      progress: document.progress,
      outcome: document.outcome,
      confidence: document.confidence,
      evidenceCount: document.evidenceCount,
      sourceSegments: document.sourceSegmentIds,
      resultEvidence: document.resultEvidence ?? [],
      observedData: document.observedData
    }
    const raw = await this.modelCall(
      level === '10m' ? buildTenMinuteSummaryPrompt(this.focusTaskCandidates()) : buildSixHourSummaryPrompt(),
      buildSummaryInput(level, inputDocument),
      controller.signal
    )
    return parseModelSupplement(raw)
  }

  private failedModelRecord(record: HistorySummaryRecord, nowMs: number, error: unknown): HistorySummaryRecord {
    const attemptCount = record.attemptCount + 1
    const message = redactSensitive(error instanceof Error ? error.message : String(error)).text
    return {
      ...record,
      modelStatus: 'failed',
      attemptCount,
      nextRetryAt: retryAt(nowMs, attemptCount, this.retryBaseMs, this.retryMaxMs),
      lastError: message.slice(0, 240),
      updatedAt: nowIso(this.now)
    }
  }
}
