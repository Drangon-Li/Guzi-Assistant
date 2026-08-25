import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('../src/renderer/src/pages/History.tsx')
const settings = read('../src/renderer/src/pages/Settings.tsx')
const settingsUi = read('../src/renderer/src/components/ui.tsx')
const app = read('../src/renderer/src/App.tsx')
const historyService = read('../src/main/history/service.ts')
const privacy = read('../src/main/privacy.ts')
const db = read('../src/main/db.ts')
const api = read('../src/renderer/src/api.ts')
const ipc = read('../src/shared/ipc-channels.ts')
const picker = read('../src/main/history/app-picker.ts')

const checks = [
  ['历史页面接入主导航', /History from ['"]\.\/pages\/History['"]/.test(app) && /key: 'history', label: '历史'/.test(app) && /shownPage === 'history'/.test(app)],
  ['展示 6 小时摘要与 10 分钟活动块', /6 小时摘要/.test(page) && /10 分钟活动块/.test(page) && /result\??\.sixHour/.test(page) && /result\??\.tenMinute/.test(page)],
  ['摘要卡展示时间、App、置信度与来源 segment', /formatTime\(item\.startAt\)/.test(page) && /appList\(item\.apps\)/.test(page) && /confidenceLabel\(item\.confidence\)/.test(page) && /sourceSegmentIds/.test(page)],
  ['事件类型作为辅助证据展开统计', /activityTypeCounts/.test(page) && /<details/.test(page) && /查看事件证据统计/.test(page) && /查看辅助证据/.test(page)],
  ['摘要卡突出工作焦点、对应任务与进展', /工作焦点/.test(page) && /对应任务/.test(page) && /item\.focusTask/.test(page) && /item\.progress/.test(page) && /item\.outcome/.test(page)],
  ['History 只保留可选择的 App 黑名单', /历史 App 黑名单/.test(page) && /historyPickApps/.test(page) && /选择 App/.test(page) && /historyExcludedApps/.test(page) && !/historyIncludedApps/.test(page) && !/保存 include/.test(page)],
  ['原生选择器读取 App Bundle ID', /showOpenDialog/.test(picker) && /CFBundleIdentifier/.test(picker) && /multiSelections/.test(picker) && /history:pick-apps/.test(api) && /history:pick-apps/.test(ipc)],
  ['黑名单按 Bundle ID 持久化并进入隐私门', /historyExcludedApps: parseHistoryAppList/.test(db) && /k === 'historyExcludedApps'/.test(db) && /excludedBundleIds: historyOnly/.test(privacy) && !/includedApps: historyOnly/.test(privacy)],
  ['支持暂停恢复与摘要', /api\.historyPause\(\)/.test(page) && /api\.historyResume\(\)/.test(page) && /api\.historySummarize\(/.test(page)],
  ['支持 10 分钟、1 小时、1 天和全部清理', /cleanRange\('10m'\)/.test(page) && /cleanRange\('1h'\)/.test(page) && /cleanRange\('1d'\)/.test(page) && /cleanRange\('all'\)/.test(page)],
  ['清理使用范围 API 或统一 clear API', /cleanCurrentRange/.test(page) && /api\.historyDeleteRange\(/.test(page) && /api\.historyClear\(/.test(page)],
  ['设置展示采集器健康指标', /History 健康/.test(settings) && /lastHeartbeatAt/.test(settings) && /collectorRestartCount/.test(settings) && /collectorDroppedEventCount/.test(settings) && /currentSegmentId/.test(settings) && /retentionExpiresAt/.test(settings)],
  ['设置提供独立 History v2 与派生开关', /historyV2Enabled/.test(settings) && /historyDerivedWorkEnabled/.test(settings) && /api\.saveSettings\(\{ historyV2Enabled: next \}\)/.test(settings) && /api\.saveSettings\(\{ historyDerivedWorkEnabled: next \}\)/.test(settings)],
  ['设置二值选项使用可访问 Toggle，圆钮有对称水平内边距', /role="switch"/.test(settingsUi) && /left-0\.5/.test(settingsUi) && /translate-x-0['"]/.test(settingsUi) && /translate-x-5/.test(settingsUi) && /<Toggle/.test(settings) && !/type="checkbox"/.test(settings)],
  ['屏幕感知技术参数默认折叠', /高级设置与隐私选项/.test(settings) && /查看采集器健康详情/.test(settings) && /<details/.test(settings)],
  ['删除/摘要完成后广播并由页面刷新',
    (historyService.match(/broadcast\('guzi-assistant:history-updated'\)/g) ?? []).length >= 4 &&
      /api\.on\('guzi-assistant:history-updated'/.test(page) &&
      /api\.on\('guzi-assistant:history-updated'/.test(settings)],
  ['两个 History 开关默认关闭且可独立回滚',
    /historyV2Enabled: map\.historyV2Enabled === 'true'/.test(db) &&
      /historyDerivedWorkEnabled: map\.historyDerivedWorkEnabled === 'true'/.test(db) &&
      /historyV2Enabled && settings\.historyDerivedWorkEnabled/.test(historyService)]
]

for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  assert.ok(ok, name)
}

console.log('\nHistory UI checks passed')
