// 设置页「屏幕感知」分区。状态仍由 pages/Settings.tsx 持有，这里只负责这一段的渲染与保存。
import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings, PermissionStatus, ScreenActivityStatus } from '@shared/types'
import type { HistoryStatus } from '@shared/history'
import { api } from '../../api'
import { permissionLabel } from '../../../../shared/platform'
import { isMac } from '../../platform'
import { Section, Toggle } from '../ui'
import HistoryDataSection from './HistoryDataSection'
import { hasBackend } from '../../supabase'

interface Props {
  settings: AppSettings
  saveSettings: (patch: Partial<AppSettings>) => Promise<boolean>
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  perms: PermissionStatus | null
  activityStatus: ScreenActivityStatus | null
  historyStatus: HistoryStatus | null
  setHistoryStatus: Dispatch<SetStateAction<HistoryStatus | null>>
  loadPerms: () => void
  loadActivityStatus: () => void
  flash: (msg: string) => void
}

export default function ScreenSenseSection({
  settings, saveSettings, setSettings, perms, activityStatus, historyStatus, setHistoryStatus, loadPerms,
  loadActivityStatus, flash
}: Props): React.JSX.Element {
  return (
    <>
      <Section title="屏幕感知">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          让谷子留意你屏幕上出现的日程和待办，不用你手动录入。默认关闭。
          开启后只把打码过的屏幕文字送去识别，截图不上传（除非你开了下面的「日程深度确认」）；
          密码框和浏览器私密窗口一律跳过，截图用完即删。
        </p>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>屏幕感知</span>
          <Toggle
            checked={settings.screenSenseEnabled}
            ariaLabel="屏幕感知"
            onChange={async (next) => {
              setSettings({ ...settings, screenSenseEnabled: next })
              await saveSettings({ screenSenseEnabled: next })
              flash(next ? '已开启屏幕感知' : '已关闭屏幕感知')
            }}
          />
        </label>

        {settings.screenSenseEnabled && (
          <details className="mt-4 rounded-lg border border-slate-200 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium text-slate-600">
              高级设置与隐私选项
              <span className="ml-2 text-xs font-normal text-slate-400">扫描策略、截图、排除应用和运行状态</span>
            </summary>
          <div className="mt-4 flex flex-col gap-4">
            <div className="border-y border-slate-100 py-3">
              {activityStatus && (
                <details className="mt-3">
                  <summary className="cursor-pointer select-none text-xs text-slate-400">
                    运行状态详情（调试用，一般无需查看）
                  </summary>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span>
                    观察器：
                    {activityStatus.observer === 'healthy'
                      ? '正常'
                      : activityStatus.observer === 'unavailable'
                        ? '已降级停止截图'
                        : '等待前台上下文'}
                  </span>
                  <span>内存事件：{activityStatus.rawEventCount}</span>
                  <span>
                    最后事件：
                    {activityStatus.lastEventAt
                      ? new Date(activityStatus.lastEventAt).toLocaleTimeString()
                      : '暂无'}
                  </span>
                  <span>
                    最后扫描：
                    {activityStatus.lastScanAt
                      ? `${new Date(activityStatus.lastScanAt).toLocaleTimeString()} · ${activityStatus.lastScanReason ?? '未知'}`
                      : '暂无'}
                  </span>
                  <span>10 分钟片段：{activityStatus.tenMinuteSegmentCount}</span>
                  <span>6 小时汇总：{activityStatus.sixHourSegmentCount}</span>
                  <span>
                    Collector：{activityStatus.collector === 'healthy' ? '正常' : activityStatus.collector === 'degraded' ? '降级' : activityStatus.collector === 'starting' ? '启动中' : '已停止'}
                  </span>
                  <span>
                    Accessibility：{activityStatus.accessibility === 'available' ? '可用' : activityStatus.accessibility === 'unavailable' ? '不可用（不影响基础事件）' : '未知'}
                  </span>
                  <span>语义覆盖率：{activityStatus.semanticCoverage}%</span>
                  <span>OCR fallback：{activityStatus.ocrFallbackCount} 次</span>
                  <span className="col-span-2">
                    最近 10 分钟构成：事件 {activityStatus.latestEventCount}（有效 {activityStatus.latestMeaningfulEventCount}） · 完整 {activityStatus.latestSemanticCompleteCount} · 部分 {activityStatus.latestSemanticPartialCount} · 空 {activityStatus.latestSemanticEmptyCount} · OCR {activityStatus.latestOcrEvidenceCount}
                  </span>
                  <span className="col-span-2">
                    触发原因：{activityStatus.recentTriggerReasons.length ? activityStatus.recentTriggerReasons.join('、') : '暂无'}
                  </span>
                  <span className="col-span-2">最近摘要：{activityStatus.recentSummary ?? '暂无'}</span>
                  {activityStatus.observerDetail && (
                    <span className="col-span-2 text-amber-600">{activityStatus.observerDetail}</span>
                  )}
                  {activityStatus.collectorDetail && (
                    <span className="col-span-2 text-amber-600">Collector：{activityStatus.collectorDetail}</span>
                  )}
                </div>
                </details>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  待办自动识别
                  <span className="ml-2 text-xs text-slate-400">
                    在聊天 / 邮件 / 浏览器 / 文档 / 日历里定期看一次屏幕文字抓待办，
                    {hasBackend ? '会消耗积分' : '每次检测会调用你配置的模型 API'}
                  </span>
                </span>
                <Toggle
                  checked={settings.todoScanEnabled}
                  ariaLabel="待办自动识别"
                  onChange={async (next) => {
                    setSettings({ ...settings, todoScanEnabled: next })
                    await saveSettings({ todoScanEnabled: next })
                    flash(next ? '会自动识别屏幕上的待办' : '已关闭待办自动识别')
                  }}
                />
              </label>
            </div>
            <div>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  检测到日程时弹窗提醒
                  <span className="ml-2 text-xs text-slate-400">
                    关闭则完全被动，只在「记忆」里留存供回看
                  </span>
                </span>
                <Toggle
                  checked={settings.screenSensePopup}
                  ariaLabel="检测到日程时弹窗提醒"
                  onChange={async (next) => {
                    setSettings({ ...settings, screenSensePopup: next })
                    await saveSettings({ screenSensePopup: next })
                    flash(next ? '检测到日程会弹窗提醒' : '已转为完全被动（只进记忆）')
                  }}
                />
              </label>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  工作记录
                  <span className="ml-2 text-xs text-slate-400">
                    把每 10 分钟的活动摘要按时间线整理成「在做什么」，供「日报」页生成工作日报（不额外调用模型）
                  </span>
                </span>
                <Toggle
                  checked={settings.screenSenseWorkLog}
                  ariaLabel="工作记录"
                  onChange={async (next) => {
                    setSettings({ ...settings, screenSenseWorkLog: next })
                    await saveSettings({ screenSenseWorkLog: next })
                    flash(next ? '已开启工作记录' : '已关闭工作记录')
                  }}
                />
              </label>
              {settings.screenSenseWorkLog && (
                <label className="mt-2 flex items-center gap-3 text-sm">
                  <span className="text-slate-500">每日自动生成日报</span>
                  <input
                    type="time"
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                    value={settings.dailyReportTime}
                    onChange={async (e) => {
                      const v = e.target.value
                      setSettings({ ...settings, dailyReportTime: v })
                      await saveSettings({ dailyReportTime: v })
                      flash(v ? `每天 ${v} 自动生成日报` : '已关闭定时日报')
                    }}
                  />
                  <span className="text-xs text-slate-400">清空 = 不自动生成</span>
                </label>
              )}
            </div>

            <div className="border-t border-slate-100 pt-4">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  日程深度确认
                  <span className="ml-2 text-xs text-slate-400">
                    检出日程候选后把截图发视觉模型二次确认，更准；注意此时
                    {hasBackend ? (
                      <><b>截图会上传云端</b>、额外耗积分</>
                    ) : (
                      <><b>截图会发给你配置的读图模型</b>、额外消耗 API 额度</>
                    )}
                  </span>
                </span>
                <Toggle
                  checked={settings.screenSenseVlmConfirm}
                  ariaLabel="日程深度确认"
                  onChange={async (next) => {
                    setSettings({ ...settings, screenSenseVlmConfirm: next })
                    await saveSettings({ screenSenseVlmConfirm: next })
                    flash(next ? '已开启日程深度确认（截图上云）' : '已关闭深度确认（仅文字上云）')
                  }}
                />
              </label>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  持续监控（自动）
                  <span className="ml-2 text-xs text-slate-400">屏幕变化时自动识别，无需手动扫描</span>
                </span>
                <Toggle
                  checked={settings.screenSenseContinuous}
                  ariaLabel="持续监控"
                  onChange={async (next) => {
                    setSettings({ ...settings, screenSenseContinuous: next })
                    await saveSettings({ screenSenseContinuous: next })
                    flash(next ? '已开启持续监控' : '已关闭持续监控')
                  }}
                />
              </label>
              {settings.screenSenseContinuous && (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-xs leading-5 text-slate-400">
                    连续 60 秒没有键鼠操作、锁屏或睡眠时都不会采集。可在托盘菜单随时暂停，暂停会取消尚未完成的云端解析。
                  </p>

                  <div className="mt-2 border-t border-slate-100 pt-3">
                    <label className="flex items-center justify-between gap-4 text-sm">
                      <span>
                        保存截图到可搜索记忆
                        <span className="ml-2 text-xs text-slate-400">本地加密保存，可在「记忆」里回看</span>
                      </span>
                      <Toggle
                        checked={settings.screenSenseKeepShots}
                        ariaLabel="保存截图到可搜索记忆"
                        onChange={async (next) => {
                          setSettings({ ...settings, screenSenseKeepShots: next })
                          await saveSettings({ screenSenseKeepShots: next })
                          flash(next ? '已开启截图保存（加密）' : '已关闭截图保存')
                        }}
                      />
                    </label>
                    {settings.screenSenseKeepShots && (
                      <label className="mt-2 flex items-center gap-3 text-sm">
                        <span className="text-slate-500">保留天数</span>
                        <input
                          type="number"
                          min={0}
                          max={365}
                          className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
                          value={settings.screenSenseRetentionDays}
                          onChange={(e) =>
                            setSettings({ ...settings, screenSenseRetentionDays: Number(e.target.value) })
                          }
                          onBlur={async (e) => {
                            const v = Math.min(365, Math.max(0, Number(e.target.value) || 0))
                            setSettings({ ...settings, screenSenseRetentionDays: v })
                            await saveSettings({ screenSenseRetentionDays: v })
                            flash('已保存截图保留期')
                          }}
                        />
                        <span className="text-xs text-slate-400">天，到期自动清；0 = 永久</span>
                      </label>
                    )}
                    <p className="mt-1.5 text-xs leading-5 text-slate-400">
                      默认关闭，保持「截图用完即弃」。开启后仅保存缩略图、用系统钥匙串加密；原图始终不留。
                    </p>
                  </div>
                </div>
              )}
            </div>

            {perms && ['denied', 'restricted'].includes(perms.screen) && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                {isMac ? '屏幕录制权限未授权，扫描会失败。请到 系统设置 → 隐私与安全性 → 屏幕录制 中允许 谷子助手。' : '屏幕捕获受到系统限制，请检查 Windows 隐私设置和组织策略。'}
              </div>
            )}
          </div>
          </details>
        )}
      </Section>

      <Section title="活动计时" desc="应用时长、工作记录和日报使用相同的有效活动区间。闲置满 60 秒、锁屏或休眠时停止计时。">
        <p className="text-xs leading-5 text-slate-400">
          应用与时间区间保留 90 天；原始历史事件和 OCR 证据保留 48 小时。
        </p>
        {activityStatus?.screenshotPauseReason && (
          <p role="status" className="mt-2 text-xs text-amber-700">自动截图已暂停：{activityStatus.screenshotPauseReason}</p>
        )}
      </Section>

      {/* History v2 的开关已从设置页移除（技术性太强）。它没开时这两段只会显示
          「未开启」和一个点不动的按钮，索性一并收起，页面才不会剩下够不着的东西。 */}
      {settings.historyV2Enabled && (
        <Section title="History 健康" desc="实时状态来自本地 collector 与 48 小时 History store；不会展示原始事件正文。">
        {historyStatus && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className={`rounded-md px-2 py-1 ${!historyStatus.enabled ? 'bg-slate-100 text-slate-500' : historyStatus.paused ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                {!historyStatus.enabled ? 'History 未开启' : historyStatus.paused ? '已暂停' : '运行中'}
              </span>
              <button
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                disabled={!historyStatus.enabled}
                onClick={async () => {
                  const next = historyStatus.paused ? await api.historyResume() : await api.historyPause()
                  setHistoryStatus(next)
                  loadActivityStatus()
                  flash(next.paused ? 'History 已暂停' : 'History 已恢复')
                }}
              >
                {historyStatus.paused ? '恢复采集' : '暂停采集'}
              </button>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer select-none text-xs text-slate-400">查看采集器健康详情</summary>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-slate-500">
              <span>
                Heartbeat：{activityStatus?.lastHeartbeatAt
                  ? new Date(activityStatus.lastHeartbeatAt).toLocaleTimeString()
                  : '暂无'}
              </span>
              <span>
                Accessibility：{activityStatus?.accessibility === 'available'
                  ? '可用'
                  : activityStatus?.accessibility === 'unavailable'
                    ? '不可用'
                    : '未知'}
              </span>
              <span>
                Input Monitoring 授权：{activityStatus?.inputMonitoringPermission === 'available'
                  ? '已授权'
                  : activityStatus?.inputMonitoringPermission === 'unavailable'
                    ? '未授权'
                    : activityStatus?.collector === 'starting' ? '检查中' : '采集器未报告'}
              </span>
              <span>
                输入监听：{activityStatus?.inputMonitoringListener === 'active'
                  ? '已建立'
                  : activityStatus?.inputMonitoringListener === 'inactive'
                    ? (activityStatus.collector === 'stopped' ? '未运行' : '未建立')
                    : '采集器未报告'}
              </span>
              <span>
                输入事件流：{activityStatus?.inputMonitoring === 'available'
                  ? '已收到事件，已验证'
                  : activityStatus?.inputMonitoring === 'unavailable'
                    ? '不可用'
                    : activityStatus?.inputMonitoringListener === 'active'
                      ? '等待首个事件'
                      : '尚未验证'}
              </span>
              <span>
                最近输入事件：{activityStatus?.lastInputEventAt
                  ? new Date(activityStatus.lastInputEventAt).toLocaleTimeString()
                  : activityStatus?.inputMonitoring === 'available' ? '旧版采集器未报告时间' : '暂无'}
              </span>
              <span>Collector 重启：{activityStatus?.collectorRestartCount ?? 0} 次</span>
              <span>丢弃事件：{(activityStatus?.collectorDroppedEventCount ?? 0) + historyStatus.health.droppedCount}</span>
              <span>抑制事件：{historyStatus.health.suppressedCount}</span>
              <span>当前 segment：{historyStatus.health.currentSegmentId ?? '暂无'}</span>
              <span>队列：{historyStatus.health.queueLength}</span>
              <span>Store 状态：{historyStatus.health.state}</span>
              <span>
                最近写入：{historyStatus.health.lastWriteAt
                  ? new Date(historyStatus.health.lastWriteAt).toLocaleTimeString()
                  : '暂无'}
              </span>
              <span>
                保留截止：{historyStatus.retentionExpiresAt
                  ? new Date(historyStatus.retentionExpiresAt).toLocaleString()
                  : '暂无'}
              </span>
              <span>10 分钟摘要：{historyStatus.summaryCounts.tenMinute}</span>
              <span>6 小时摘要：{historyStatus.summaryCounts.sixHour}</span>
              {historyStatus.health.lastError && (
                <span className="col-span-2 text-amber-600">最近错误：{historyStatus.health.lastError}</span>
              )}
            </div>
            </details>
          </>
        )}
        {!historyStatus && <p className="text-xs text-slate-400">正在读取 History 状态…</p>}
        </Section>
      )}

      {settings.historyV2Enabled && <HistoryDataSection flash={flash} />}

      <Section title="权限状态">
        {perms && (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span>{isMac ? '屏幕录制（截图捕获其他应用内容需要）' : '屏幕捕获状态'}</span>
              <span
                className={`text-xs ${perms.screen === 'granted' ? 'text-emerald-600' : 'text-amber-600'}`}
              >
                {permissionLabel(perms.screen)}
              </span>
            </div>
            <button
              className="mt-1 self-start rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
              onClick={loadPerms}
            >
              刷新状态
            </button>
          </div>
        )}
      </Section>
    </>
  )
}
