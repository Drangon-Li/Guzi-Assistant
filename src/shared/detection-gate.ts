// 屏幕感知候选的入队门槛与撤回判定（issue #128）。
//
// 背景：模型每条候选都给了 confidence 和 suggested_action，但屏幕感知这条路上一个都没读——
// 模型吐什么就全进待确认队列。用户自己干活时屏幕上的碎事（终端命令、发给 AI 的指令、
// TODO 清单）长得跟待办一模一样，一屏能收编十几条，全都没时间。
//
// 这里把"是不是一件事"和"这事值得记吗"分开：不值得记的仍然进 detections 表（去重要用），
// 但标成 archived，不占用户的待确认队列。

import type { ParsedItem } from './parsing'

/** 已解出具体时间的候选：时间本身就是强信号，置信度门槛可以低一些。 */
export const TIMED_MIN_CONFIDENCE = 0.5
/** 没有时间的候选：噪声几乎全在这一类，要求模型明确有把握才打扰用户。 */
export const TIMELESS_MIN_CONFIDENCE = 0.75

export type QueueDecision = 'queue' | 'archive'

/**
 * 一条候选该进待确认队列，还是只归档留痕。
 * hasTime 由调用方传（extraction.strong），因为 due_time/start_time 的取舍在 parsedToExtraction 里已经做过。
 */
export function detectionQueueDecision(item: ParsedItem, hasTime: boolean): QueueDecision {
  if (item.suggested_action === 'ignore') return 'archive' // 模型直说了别记
  if (item.belongs_to_user === 'no') return 'archive' // 明确是别人的事
  const floor = hasTime ? TIMED_MIN_CONFIDENCE : TIMELESS_MIN_CONFIDENCE
  return item.confidence >= floor ? 'queue' : 'archive'
}

// ---------- 完成即撤 ----------

// 勾选框、对钩、以及中英文的完成词。OCR 出来的对钩字形不稳定，多列几个变体。
const DONE_MARKS = /\[[xX√✓]\]|[✓✔√☑🗹]|\bdone\b|已完成|已办|完成了|搞定/

/** 归一化：OCR 的空格/全角/大小写不可靠，比对前统统抹平。 */
function normalize(s: string): string {
  return s.replace(/\s+/g, '').replace(/[，。、！？：；""''（）]/g, '').toLowerCase()
}

/**
 * 屏幕文字里这条待办是否已显示为「做完了」。
 *
 * 标题是模型改写过的，未必和屏幕原文逐字一致，所以取前 6 个字做锚点在行内找——
 * 太短会误命中（"实现"能撞上任何一行），太长又会因 OCR 漏字而找不到。
 */
export function looksCompleted(title: string, screenText: string): boolean {
  const anchor = normalize(title).slice(0, 6)
  if (anchor.length < 4) return false // 标题太短，锚点不可靠，宁可不撤
  for (const line of screenText.split('\n')) {
    if (!normalize(line).includes(anchor)) continue
    if (DONE_MARKS.test(line)) return true
  }
  return false
}
