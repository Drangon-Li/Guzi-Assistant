// 会议转录 → 任务清单。
//
// 这里是整个语音纪要最容易做砸的一环：会上说的话十有八九不是给用户的。
// 「这个下周之前搞定」——谁搞定？光看转录文本判不出来，模型只能瞎猜。
//
// 所以解析时额外注入两块上下文：
//  1. 用户档案（姓名/昵称/账号/岗位）——转录会把人名写错，得让模型知道用户是谁；
//  2. 用户最近几天在做什么（本机工作记录）——「你那条线」和会上分下来的活能对上号。
// 第 2 块是用户明确要求的：「根据谷子助手已有的上下文，最近用户在干什么，然后进行分析」。
import { createSource, deleteSourceRow, findDuplicateTitle, listWorkRecordsSince } from '../db'
import { excerptOf, HINTS } from '../capture'
import { parseToItems } from '../parser'
import { createTaskFromItem } from '../task-ingest'
import { redactSensitive } from '@shared/sensitive'
import { recentWorkBlock } from '@shared/voicenotes'
import { dayKey } from '@shared/work-report'
import { assertContentEpoch, captureContentEpoch } from '../content-lifecycle'

/** 一场会的转录可能很长；超过这个长度截断，尾部（结论和分工通常在后面）优先保留。 */
const MAX_TRANSCRIPT_CHARS = 24_000

function clampTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text
  // 会议的行动项几乎都在后半段，掐头不掐尾
  return `（转录过长，已省略开头部分）\n${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`
}

/**
 * 解析一场会的转录，把属于用户的行动项落成待确认任务。
 * 返回入库任务数。
 */
export async function parseVoiceTranscript(
  transcript: string,
  appName: string | null
): Promise<number> {
  const epoch = captureContentEpoch()
  const text = clampTranscript(transcript)
  const source = createSource({
    type: 'voice_note',
    excerpt: excerptOf(text),
    content: text.slice(0, 8000),
    filePath: null
  })

  // 上云前脱敏：会上会念身份证号、验证码、报销卡号
  const safe = redactSensitive(text).text
  const hint = `${HINTS.voice_note}${recentWorkBlock(recentWorkForContext())}${
    appName ? `\n（这场会来自「${appName}」）` : ''
  }`

  let items = await parseToItems({ text: safe, hint })
  assertContentEpoch(epoch)
  // 会议场景刻意不做「自动加入」：哪怕 confirmMode 是 aggressive，
  // 转录错字 + 归属靠猜，直接进日程风险太高，一律走待确认让用户过一眼。
  items = items.filter((it) => it.belongs_to_user !== 'no')

  let created = 0
  for (const it of items) {
    if (findDuplicateTitle(it.title, it.start_time, it.due_time)) continue
    createTaskFromItem(source.id, it, 'pending')
    created += 1
  }
  // 没有任何任务引用的来源在 UI 上不可见也删不掉，不留库
  if (created === 0) deleteSourceRow(source.id)
  return created
}

/** 用户最近几天在做什么。三天窗口：再久远的活和当下这场会基本没关系了。 */
function recentWorkForContext(): { content: string; task: string | null }[] {
  const since = dayKey(new Date(Date.now() - 3 * 86_400_000))
  return listWorkRecordsSince(since)
    .slice(-40)
    .map((r) => ({ content: r.content, task: r.task }))
}
