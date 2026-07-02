import {
  getPersonalMemory,
  getProfile,
  listTasks,
  listWorkRecordsSince,
  setPersonalMemory,
  type PersonalMemory
} from './db'
import { callModel } from './parser'
import {
  buildBaseMemoryPrompt,
  buildPersonalMemoryPrompt,
  dayKey,
  groupWorkPeriods,
  periodLabel
} from '@shared/work-report'
import type { Profile } from '@shared/types'

const LOOKBACK_DAYS = 14

interface Material {
  profile: Profile
  activityLines: string[]
  tasks: string[]
}

/** 画像素材：档案 + 近 14 天活动（按天/时段聚合）+ 任务标题。 */
function gatherMaterial(): Material {
  const profile = getProfile()
  if (!profile) throw new Error('尚未完成用户档案设置')

  const since = new Date()
  since.setDate(since.getDate() - LOOKBACK_DAYS)
  const records = listWorkRecordsSince(dayKey(since))
  const tasks = listTasks()
    .filter((t) => t.belongsToUser !== 'no' && t.status !== 'ignored')
    .map((t) => t.title)
    .slice(0, 40)

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
  return { profile, activityLines: activityLines.slice(-120), tasks }
}

/** 打模型并剥掉偶发的代码块围栏。 */
async function generate(instructions: string, text: string): Promise<string> {
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
  if (!content) throw new Error('画像生成失败：模型无输出')
  return content
}

/** 刷新近期行为画像：近 14 天活动 + 任务 → 云端归纳「最近在做什么」。 */
export async function refreshPersonalMemory(): Promise<PersonalMemory> {
  const { profile, activityLines, tasks } = gatherMaterial()
  if (!activityLines.length && !tasks.length)
    throw new Error('还没有足够的历史活动，用一段时间后再来生成')
  const cur = getPersonalMemory()
  const { instructions, text } = buildPersonalMemoryPrompt(
    profile.name,
    activityLines,
    tasks,
    cur.recent,
    cur.base
  )
  return setPersonalMemory('recent', await generate(instructions, text))
}

/** 刷新基本画像：以档案为主、长期活动模式为辅，小幅演进用户的身份定义（3~6 条）。 */
export async function refreshBaseMemory(): Promise<PersonalMemory> {
  const { profile, activityLines, tasks } = gatherMaterial()
  const profileDesc = [
    `姓名：${profile.name}`,
    `身份：${profile.identity}`,
    profile.org ? `组织/学校/公司：${profile.org}` : '',
    profile.group ? `班级/课题组/岗位：${profile.group}` : '',
    profile.workHours ? `工作时间偏好：${profile.workHours}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const { instructions, text } = buildBaseMemoryPrompt(
    profile.name,
    profileDesc,
    activityLines,
    tasks,
    getPersonalMemory().base
  )
  return setPersonalMemory('base', await generate(instructions, text))
}
