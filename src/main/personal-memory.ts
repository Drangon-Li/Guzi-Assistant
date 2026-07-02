import {
  getPersonalMemory,
  getProfile,
  listTasks,
  listWorkRecordsSince,
  setPersonalMemory,
  type PersonalMemory
} from './db'
import { callModel } from './parser'
import { buildPersonalMemoryPrompt, dayKey, groupWorkPeriods, periodLabel } from '@shared/work-report'

const LOOKBACK_DAYS = 14

/** 从近 14 天工作记录 + 当前任务归纳个人画像，写入本地并返回。无素材则抛出。 */
export async function refreshPersonalMemory(): Promise<PersonalMemory> {
  const profile = getProfile()
  if (!profile) throw new Error('尚未完成用户档案设置')

  const since = new Date()
  since.setDate(since.getDate() - LOOKBACK_DAYS)
  const records = listWorkRecordsSince(dayKey(since))
  const tasks = listTasks()
    .filter((t) => t.belongsToUser !== 'no' && t.status !== 'ignored')
    .map((t) => t.title)
    .slice(0, 40)
  if (!records.length && !tasks.length)
    throw new Error('还没有足够的历史活动，用一段时间后再来生成记忆')

  // 活动按天分组、每天内按时段聚合，喂给模型作画像素材
  const byDay = new Map<string, typeof records>()
  for (const r of records) {
    const d = r.createdAt.slice(0, 10)
    const arr = byDay.get(d) ?? []
    arr.push(r)
    byDay.set(d, arr)
  }
  const activityLines: string[] = []
  for (const [d, recs] of byDay) {
    for (const p of groupWorkPeriods(recs)) {
      activityLines.push(`${d} ${periodLabel(p)} ${p.app ? `[${p.app}] ` : ''}${p.summary}`)
    }
  }

  const { instructions, text } = buildPersonalMemoryPrompt(
    profile.name,
    activityLines.slice(-120),
    tasks,
    getPersonalMemory().recent,
    getPersonalMemory().base
  )
  const output = await callModel(
    instructions,
    [{ role: 'user', content: [{ type: 'input_text', text }] }],
    'parse_text'
  )
  const content = output
    .trim()
    .replace(/^```(?:markdown)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
  if (!content) throw new Error('记忆生成失败：模型无输出')
  return setPersonalMemory('recent', content)
}
