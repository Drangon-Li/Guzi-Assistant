// 聊天版面发言人归属（#54）离线单测。运行：npm run test:chatlayout
import {
  looksLikeChat,
  clusterChatSpeakers,
  formatChatTranscript
} from '../src/shared/chat-layout.ts'

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 左=对方(x 小)、右=自己(x 大)
const box = (text, x, y, w = 0.3) => ({ text, x, y, w, h: 0.04 })
const chat = [
  box('在吗', 0.05, 0.1), // 对方 左
  box('在的', 0.65, 0.2), // 自己 右
  box('帮我交下周报', 0.05, 0.3), // 对方 左
  box('好的', 0.7, 0.4) // 自己 右
]

check('识别为聊天', looksLikeChat(chat))
check('普通左对齐文档不算聊天', !looksLikeChat([box('标题', 0.05, 0.1), box('正文一', 0.05, 0.2), box('正文二', 0.05, 0.3), box('正文三', 0.05, 0.4)]))
check('行数太少不算聊天', !looksLikeChat([box('在吗', 0.05, 0.1), box('在', 0.7, 0.2)]))

const lines = clusterChatSpeakers(chat)
check('聚类发言人', eq(lines, [
  { sender: 'other', text: '在吗' },
  { sender: 'me', text: '在的' },
  { sender: 'other', text: '帮我交下周报' },
  { sender: 'me', text: '好的' }
]))

check('按 y 从上到下排序', eq(
  clusterChatSpeakers([box('后', 0.7, 0.9), box('先', 0.05, 0.1)]).map((l) => l.text),
  ['先', '后']
))

check('居中行（时间戳）被跳过', eq(
  clusterChatSpeakers([box('昨天 14:00', 0.4, 0.05, 0.2), box('在吗', 0.05, 0.1)]),
  [{ sender: 'other', text: '在吗' }]
))

check('空文本被剔除', eq(clusterChatSpeakers([box('  ', 0.05, 0.1), box('hi', 0.7, 0.2)]), [{ sender: 'me', text: 'hi' }]))

check('转写格式', formatChatTranscript(lines) === '对方：在吗\n自己：在的\n对方：帮我交下周报\n自己：好的')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
