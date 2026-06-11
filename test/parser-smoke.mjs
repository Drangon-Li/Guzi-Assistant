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

async function parse(sample) {
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
  return parseModelOutput(extractText(await res.json()).trim())
}

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- 用例 1：群通知（归属判断） ----
const groupNotice = `【课题组群】导师：@所有人 本周五下午3点开组会，地点 A301，请勿迟到。
分工：李雷负责整理实验数据，张三准备文献分享PPT，韩梅梅写周报。
【教务通知】请各位同学于6月30日前完成下学期注册缴费。
【广告】AI 求职训练营火热招生中，名师指导，限时优惠！`

console.log('用例 1：群通知归属判断…')
const items1 = await parse(groupNotice)
console.log(JSON.stringify(items1, null, 2))
check(
  '点名张三的 PPT 任务 → belongs=yes 且高置信度',
  items1.some((i) => i.title.includes('PPT') && i.belongs_to_user === 'yes' && i.confidence >= 0.85)
)
check(
  '@所有人组会 → 不能直接 add',
  items1
    .filter((i) => i.item_type === 'meeting')
    .every((i) => i.suggested_action !== 'add' || i.belongs_to_user !== 'yes')
)
check(
  '李雷/韩梅梅的任务不属于用户',
  items1.every(
    (i) => (!i.title.includes('实验数据') && !i.title.includes('周报')) || i.belongs_to_user === 'no'
  )
)
check('广告不生成任务', items1.every((i) => !i.title.includes('训练营') && !i.title.includes('招生')))
check(
  '注册缴费有截止时间',
  items1.some((i) =>
    i.title.includes('注册') || i.title.includes('缴费') ? i.due_time?.startsWith('2026-06-30') : false
  )
)

// ---- 用例 2：考试通知（注意事项 + 地点 + 多事项拆分） ----
const examNotice = `同学，你好！
本次博资考笔试时间统一为：2026年6月11日（周四）9:30 – 11:30。
你的考试类型为：闭卷
你的考试地点为：C8-8308 象山
注：博资考面试时间为6月17日全天，具体地点和答辩时间会在答辩前由考核秘书通知到个人。
以下为博资考笔试须知，请详细阅读，遵照要求准时参加考试。
笔试考生须知
1. 考生需持本人一卡通和身份证进入规定的考场，自备黑色签字笔。
2. 提前 10 分钟到达考场，并扫码签到。开考 30 分钟后，考生不得入场。
3. 闭卷考试仅限携带文具、证件，开卷考试除携带文具证件外，仅限纸质材料。
4. 与考试无关的物品，包括手机、智能手表、蓝牙耳机等须在考前10分钟放置考场前方空旷区域。
5. 考生入场后，将本人一卡通和身份证放在桌子左上角，以便核验。
9. 开考1小时后至考试结束前15分钟内（10:30–11:15）可提前交卷。
考务咨询电话：010-82821018 联系人：张芮老师
北京中关村学院培养部 2026年6月3日`

console.log('\n用例 2：考试通知信息提取…')
const items2 = await parse(examNotice)
console.log(JSON.stringify(items2, null, 2))
const written = items2.find((i) => i.title.includes('笔试'))
check('笔试任务被提取', !!written)
check('笔试开始时间为 2026-06-11T09:30', written?.start_time === '2026-06-11T09:30')
check('笔试地点包含 C8-8308', !!written?.location?.includes('8308'))
check('笔试注意事项 ≥ 3 条', (written?.notes.length ?? 0) >= 3)
check(
  '面试作为独立任务提取（6月17日）',
  items2.some((i) => i.title.includes('面试') && (i.start_time ?? i.due_time ?? '').startsWith('2026-06-17'))
)

console.log(failed ? `\n${failed} 项检查未通过（属于解析质量问题，不一定是代码 bug）` : '\n全部通过')
