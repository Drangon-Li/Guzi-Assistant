// 助手对话冒烟测试：捕获候选 / 对话确认+修改 / 日程问答
// 运行：node test/assistant-smoke.mjs
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildAssistantInstructions, extractText, parseAssistantOutput } from '../src/shared/parsing.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf-8')
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
)

const profile = {
  name: '张三',
  nicknames: ['三儿'],
  accounts: ['zhangsan99'],
  identity: 'student',
  org: '北航',
  group: '数据挖掘课题组',
  workHours: '',
  confirmMode: 'standard'
}

async function turn(history, tasksJson, candidates) {
  const res = await fetch(`${env.AL1_API_BASE}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.AL1_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.AL1_MODEL,
      instructions: buildAssistantInstructions(profile, tasksJson, candidates),
      input: history.map((m) => ({
        role: m.role,
        content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }]
      })),
      reasoning: { effort: 'low' }
    })
  })
  if (!res.ok) {
    console.error('HTTP', res.status, (await res.text()).slice(0, 300))
    process.exit(1)
  }
  return parseAssistantOutput(extractText(await res.json()).trim())
}

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const tasks = JSON.stringify([
  { title: '参加组会并做文献分享', status: 'scheduled', start_time: '2026-06-12T15:00', due_time: null, location: 'A301', priority: 'medium' },
  { title: '提交数据挖掘课程论文', status: 'scheduled', start_time: null, due_time: '2026-06-20T23:59', location: null, priority: 'high' },
  { title: '完成学期注册缴费', status: 'pending', start_time: null, due_time: '2026-06-30T23:59', location: null, priority: 'medium' }
])

// ---- 场景 1：捕获 ----
const notice = `【实验室群】导师：张三下周一下午2点来我办公室讨论开题报告；另外提醒大家，周四前把本月设备使用登记表填了。`
console.log('场景 1：发送通知，期望生成候选…')
const t1 = await turn([{ role: 'user', content: notice }], tasks, null)
console.log(JSON.stringify(t1, null, 1))
check('生成了 1~3 个候选', t1.candidates.length >= 1 && t1.candidates.length <= 3)
check('reply 非空且不含 JSON 痕迹', !!t1.reply && !t1.reply.includes('"title"'))
check('点名任务在候选中且时间正确', t1.candidates.some((c) => c.title.includes('开题') && c.start_time === '2026-06-15T14:00'))
check('此场景没有 add', t1.add.length === 0)

// ---- 场景 2：对话确认 + 修改 ----
console.log('\n场景 2：对话选择第一个并修改时间…')
const t2 = await turn(
  [
    { role: 'user', content: notice },
    { role: 'assistant', content: t1.reply },
    { role: 'user', content: '第一个加一下吧，不过时间改到下周二上午10点' }
  ],
  tasks,
  t1.candidates
)
console.log(JSON.stringify({ reply: t2.reply, add: t2.add }, null, 1))
check('返回了 add 指令', t2.add.length === 1)
check('candidate 序号为 1', t2.add[0]?.candidate === 1)
check(
  'patch 把时间改到 2026-06-16T10:00',
  JSON.stringify(t2.add[0]?.patch ?? {}).includes('2026-06-16T10:00')
)

// ---- 场景 3：日程问答 ----
console.log('\n场景 3：问"今天有什么日程？我现在该干什么？"…')
const t3 = await turn(
  [{ role: 'user', content: '今天有什么日程？另外我现在应该先干什么？' }],
  tasks,
  null
)
console.log(JSON.stringify({ reply: t3.reply }, null, 1))
check('提到今天的组会', t3.reply.includes('组会'))
check('给出了行动建议', t3.reply.length > 20)
check('问答场景无候选无 add', t3.candidates.length === 0 && t3.add.length === 0)

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
