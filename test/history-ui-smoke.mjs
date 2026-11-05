import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
// 目录整体拼接：数据层/设置页按领域拆成多文件后，断言不必钉死在某一个文件上。
const readDir = (dir, ext) =>
  readdirSync(new URL(dir, import.meta.url))
    .filter((f) => f.endsWith(ext))
    .map((f) => read(`${dir}${f}`))
    .join('\n')
// 原「历史」页已并入日报页：内容进 ActivityDetail，采集/黑名单/清理进设置页。
const activity = read('../src/renderer/src/components/ActivityDetail.tsx')
const reports = read('../src/renderer/src/pages/Reports.tsx')
const settings =
  read('../src/renderer/src/pages/Settings.tsx') +
  readDir('../src/renderer/src/components/settings/', '.tsx')
const settingsUi = read('../src/renderer/src/components/ui.tsx')
const app = read('../src/renderer/src/MainApp.tsx')
const historyService = read('../src/main/history/service.ts')
const privacy = read('../src/main/privacy.ts')
const db = readDir('../src/main/db/', '.ts')
const api = read('../src/renderer/src/api.ts')
const ipc = read('../src/shared/ipc-channels.ts')
const picker = read('../src/main/history/app-picker.ts')

const checks = [
  // 只认模块路径，不钉死默认/具名导入的写法——加个具名导出不该算契约破坏
  ['活动明细并入日报页且旧 history 路由重定向', /from ['"]\.\.\/components\/ActivityDetail['"]/.test(reports) && /'activity', '活动明细'/.test(reports) && !/key: 'history'/.test(app) && /route === 'history'/.test(app) && /(?:setPage|navigate)\('reports'\)/.test(app)],
  ['展示 6 小时摘要与 10 分钟活动块', /6 小时摘要/.test(activity) && /10 分钟活动块/.test(activity) && /result\??\.sixHour/.test(activity) && /result\??\.tenMinute/.test(activity)],
  ['摘要卡展示时间、App、置信度与来源 segment', /formatTime\(item\.startAt\)/.test(activity) && /appList\(item\.apps\)/.test(activity) && /confidenceLabel\(item\.confidence\)/.test(activity) && /sourceSegmentIds/.test(activity)],
  ['事件类型作为辅助证据展开统计', /activityTypeCounts/.test(activity) && /<details/.test(activity) && /查看事件证据统计/.test(activity) && /查看辅助证据/.test(activity)],
  ['摘要卡突出工作焦点、对应任务与进展', /工作焦点/.test(activity) && /对应任务/.test(activity) && /item\.focusTask/.test(activity) && /item\.progress/.test(activity) && /item\.outcome/.test(activity)],
  ['History 只保留可选择的 App 黑名单', /历史 App 黑名单/.test(settings) && /historyPickApps/.test(settings) && /选择 App/.test(settings) && /historyExcludedApps/.test(settings) && !/historyIncludedApps/.test(settings) && !/保存 include/.test(settings)],
  ['原生选择器读取 App Bundle ID', /showOpenDialog/.test(picker) && /CFBundleIdentifier/.test(picker) && /multiSelections/.test(picker) && /history:pick-apps/.test(api) && /history:pick-apps/.test(ipc)],
  ['黑名单按 Bundle ID 持久化并进入隐私门', /historyExcludedApps: parseHistoryAppList/.test(db) && /k === 'historyExcludedApps'/.test(db) && /excludedBundleIds: historyOnly/.test(privacy) && !/includedApps: historyOnly/.test(privacy)],
  ['设置页管采集暂停恢复，日报页管手动摘要', /api\.historyPause\(\)/.test(settings) && /api\.historyResume\(\)/.test(settings) && /api\.historySummarize\(/.test(activity)],
  ['支持 10 分钟、1 小时、1 天和全部清理', /cleanRange\(/.test(settings) && /'10m', '最近 10 分钟'/.test(settings) && /'1h', '最近 1 小时'/.test(settings) && /'1d', '最近 1 天'/.test(settings) && /'all', '全部 48 小时'/.test(settings)],
  ['清理使用范围 API 或统一 clear API', /api\.historyDeleteRange\(/.test(settings) && /api\.historyClear\(/.test(settings)],
  ['设置展示采集器健康指标', /History 健康/.test(settings) && /lastHeartbeatAt/.test(settings) && /collectorRestartCount/.test(settings) && /collectorDroppedEventCount/.test(settings) && /currentSegmentId/.test(settings) && /retentionExpiresAt/.test(settings)],
  // History v2 的两个开关已从设置页移除（技术性太强）：数据层仍可独立控制，
  // 由下面「两个 History 开关默认关闭且可独立回滚」那条守着。UI 侧只保证没开时不留孤儿分区。
  ['History v2 未开启时不显示相关分区', /settings\.historyV2Enabled && \(/.test(settings) && /settings\.historyV2Enabled && <HistoryDataSection/.test(settings) && !/api\.saveSettings\(\{ historyV2Enabled: next \}\)/.test(settings)],
  ['设置二值选项使用可访问 Toggle，圆钮有对称水平内边距', /role="switch"/.test(settingsUi) && /left-0\.5/.test(settingsUi) && /translate-x-0['"]/.test(settingsUi) && /translate-x-5/.test(settingsUi) && /<Toggle/.test(settings) && !/type="checkbox"/.test(settings)],
  ['屏幕感知技术参数默认折叠', /高级设置与隐私选项/.test(settings) && /查看采集器健康详情/.test(settings) && /<details/.test(settings)],
  ['删除/摘要完成后广播并由页面刷新',
    (historyService.match(/broadcast\('guzi-assistant:history-updated'\)/g) ?? []).length >= 4 &&
      /api\.on\('guzi-assistant:history-updated'/.test(activity) &&
      /api\.on\('guzi-assistant:history-updated'/.test(settings)],
  // History v2 默认开启（设置页不暴露开关）；工作记录只从时间线派生，不再有派生开关和计时方式切换。
  ['History v2 默认开启，工作记录只走时间线派生，设置页不再有计时方式切换',
    /historyV2Enabled: map\.historyV2Enabled !== 'false'/.test(db) &&
      !/historyDerivedWorkEnabled|activityTimelineMode/.test(db + settings) &&
      /deriveTimelineWorkRecords/.test(historyService)]
]

for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  assert.ok(ok, name)
}

console.log('\nHistory UI checks passed')
