// 纯函数单测：关键词匹配 + 选最优。运行：npm run test:screen
import { matchKeywords, DEFAULT_SCREEN_KEYWORDS } from '../src/shared/keywords.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- matchKeywords ----
check('命中单个关键词', matchKeywords('明天下午开会议', ['会议']).join() === '会议')
check(
  '多关键词去重命中',
  JSON.stringify(matchKeywords('会议和考试通知，考试很重要', ['会议', '考试'])) ===
    JSON.stringify(['会议', '考试'])
)
check('英文大小写不敏感', matchKeywords('Project DEADLINE today', ['deadline']).join() === 'deadline')
check('未命中返回空数组', matchKeywords('今天天气不错', ['会议', '考试']).length === 0)
check('默认词表非空', DEFAULT_SCREEN_KEYWORDS.length > 0)
check(
  '默认词表含会议/日程/考试',
  ['会议', '日程', '考试'].every((k) => DEFAULT_SCREEN_KEYWORDS.includes(k))
)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
if (failed) process.exit(1)
