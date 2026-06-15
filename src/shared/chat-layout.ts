/**
 * 聊天截图「谁说的」版面归属（#54）：拿 OCR 的文字 box 坐标，按左/右气泡聚类发言人。
 * 思路同 ScreenMind layout_analyzer._format_chat_messages：自己发的气泡靠右、对方靠左。
 * 把「谁说的」喂进解析 prompt → 归属判断更准（别人 @ 你让你交的 = 你的事）。
 *
 * 纯几何，坐标用归一化值（0~1，左上原点；OCR 层负责把 Vision 的左下原点转过来）。
 */
export interface TextBox {
  text: string
  x: number // 左边缘
  y: number // 上边缘
  w: number
  h: number
}

export interface ChatLine {
  sender: 'me' | 'other'
  text: string
}

const SELF_CENTER = 0.55 // 行中心 x 超过此值 → 靠右 → 自己
const OTHER_CENTER = 0.45 // 行中心 x 低于此值 → 靠左 → 对方

function centerX(b: TextBox): number {
  return b.x + b.w / 2
}

/**
 * 是否像聊天界面：同时存在明显靠右(自己)与明显靠左(对方)的气泡。
 * 普通文档/网页几乎不会把文字右对齐，故「有右对齐气泡」是聊天的强信号。
 */
export function looksLikeChat(boxes: TextBox[]): boolean {
  if (boxes.length < 4) return false
  let right = 0
  let left = 0
  for (const b of boxes) {
    const c = centerX(b)
    if (c > SELF_CENTER) right++
    else if (c < OTHER_CENTER) left++
  }
  return right >= 1 && left >= 1
}

/** 按 box 坐标聚类发言人，返回从上到下的发言序列（跳过居中的时间戳/系统行）。 */
export function clusterChatSpeakers(boxes: TextBox[]): ChatLine[] {
  return [...boxes]
    .sort((a, b) => a.y - b.y) // 从上到下
    .map((b): ChatLine | null => {
      const c = centerX(b)
      const text = b.text.trim()
      if (!text) return null
      if (c > SELF_CENTER) return { sender: 'me', text }
      if (c < OTHER_CENTER) return { sender: 'other', text }
      return null // 居中（时间戳/系统提示）不归任何人
    })
    .filter((l): l is ChatLine => l !== null)
}

/** 发言序列 → 「对方: …/自己: …」转写文本，供解析 prompt 用。 */
export function formatChatTranscript(lines: ChatLine[]): string {
  return lines.map((l) => `${l.sender === 'me' ? '自己' : '对方'}：${l.text}`).join('\n')
}
