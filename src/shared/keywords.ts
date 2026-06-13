/** 屏幕感知建议的默认触发关键词；用户可在设置页增删 */
export const DEFAULT_SCREEN_KEYWORDS = [
  '会议',
  '日程',
  '考试',
  '截止',
  'deadline',
  'ddl',
  '报名',
  '面试',
  '笔试',
  '作业',
  '答辩',
  '讲座',
  '预约',
  '缴费',
  '提交',
  '通知',
  '签到',
  '面谈',
  '活动'
]

/** 返回 text 中命中的关键词（去重，大小写不敏感） */
export function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase()
  const hits: string[] = []
  for (const kw of keywords) {
    const k = kw.trim()
    if (k && lower.includes(k.toLowerCase()) && !hits.includes(k)) hits.push(k)
  }
  return hits
}
