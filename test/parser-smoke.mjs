// 冒烟测试：用真实 API 验证 buildInstructions 的归属判断规则与输出规整。
// 运行：npm run test:parser（依赖 al1/.env 中的 API 配置）
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildInstructions, extractText, parseModelOutput } from '../src/shared/parsing.ts'

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

const sample = `【课题组群】导师：@所有人 本周五下午3点开组会，地点 A301，请勿迟到。
分工：李雷负责整理实验数据，张三准备文献分享PPT，韩梅梅写周报。
【教务通知】请各位同学于6月30日前完成下学期注册缴费。
【广告】AI 求职训练营火热招生中，名师指导，限时优惠！`

console.log('请求中…')
const res = await fetch(`${env.AL1_API_BASE}/v1/responses`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.AL1_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: env.AL1_MODEL,
    instructions: buildInstructions(profile),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `以下是用户从剪切板提交的文本（通常来自聊天、通知或邮件），请提取其中的行动项。\n\n=== 用户提交的内容 ===\n${sample}`
          }
        ]
      }
    ],
    reasoning: { effort: 'low' }
  })
})

if (!res.ok) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 300))
  process.exit(1)
}

const items = parseModelOutput(extractText(await res.json()).trim())
console.log(JSON.stringify(items, null, 2))

const checks = [
  [
    '点名张三的 PPT 任务 → belongs=yes 且高置信度',
    items.some((i) => i.title.includes('PPT') && i.belongs_to_user === 'yes' && i.confidence >= 0.85)
  ],
  [
    '@所有人组会 → 不能直接 add',
    items
      .filter((i) => i.item_type === 'meeting')
      .every((i) => i.suggested_action !== 'add' || i.belongs_to_user !== 'yes')
  ],
  ['李雷/韩梅梅的任务不属于用户', items.every((i) => !i.title.includes('实验数据') && !i.title.includes('周报') || i.belongs_to_user === 'no')],
  ['广告不生成任务', items.every((i) => !i.title.includes('训练营') && !i.title.includes('招生'))],
  ['注册缴费有截止时间', items.some((i) => i.title.includes('注册') || i.title.includes('缴费') ? i.due_time?.startsWith('2026-06-30') : false)]
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
console.log(failed ? `${failed} 项检查未通过（属于解析质量问题，不一定是代码 bug）` : '全部通过')
