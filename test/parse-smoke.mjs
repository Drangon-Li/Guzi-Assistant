// 纯函数单测：模型输出解析（畸形/越界输入的防御）。运行：npm run test:parse
import { parseModelOutput, parseAssistantOutput, applyCandidatePatch, normalizeItem, resolveAddPicks } from '../src/shared/parsing.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
function throws(fn) {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// ---- parseModelOutput ----
check('提取 items 并规整', parseModelOutput('{"items":[{"title":"开会"}]}').length === 1)
check('```json 围栏可解析', parseModelOutput('```json\n{"items":[{"title":"a"}]}\n```')[0].title === 'a')
check('前后有解释文字也能提取', parseModelOutput('好的，结果如下：{"items":[{"title":"x"}]} 完毕').length === 1)
check(
  '多个 JSON 示例时提取平衡对象',
  parseModelOutput('示例：{"format":"json"} 实际：{"items":[{"title":"x"}]}').length === 1
)
check('items 缺失返回空数组', parseModelOutput('{"foo":1}').length === 0)
check('items 内非对象/无标题被丢弃', parseModelOutput('{"items":[1,"a",{},{"title":"ok"}]}').length === 1)
check('完全无 JSON 抛错', throws(() => parseModelOutput('抱歉我无法解析')))
check('JSON 损坏抛错', throws(() => parseModelOutput('{"items": [bad}')))

// ---- parseAssistantOutput ----
const env1 = parseAssistantOutput('{"reply":"你好","candidates":[{"title":"a"}]}')
check('reply 正常提取', env1.reply === '你好' && env1.candidates.length === 1)
check(
  'candidates 最多 3 条',
  parseAssistantOutput('{"candidates":[{"title":"1"},{"title":"2"},{"title":"3"},{"title":"4"}]}').candidates.length === 3
)
check('无 reply 但有候选 → 默认引导语', parseAssistantOutput('{"candidates":[{"title":"a"}]}').reply === '我发现了这些事项：')
check('无 reply 无候选 → （无回复）', parseAssistantOutput('{}').reply === '（无回复）')
check(
  '模型不守约输出纯文本 → 当纯回复不抛错',
  parseAssistantOutput('今天没有安排，好好休息～').reply === '今天没有安排，好好休息～'
)
check(
  '纯文本带代码围栏 → 去围栏后当纯回复',
  parseAssistantOutput('```\n没有 JSON 的普通回答\n```').reply === '没有 JSON 的普通回答'
)
const addEnv = parseAssistantOutput('{"reply":"r","add":[{"candidate":1,"force":true},{"candidate":0},{"candidate":2.5},{"candidate":"x"}]}')
check('add 过滤非法 candidate 序号（仅留正整数）', addEnv.add.length === 1 && addEnv.add[0].candidate === 1)
check('add 的 force 透传', addEnv.add[0].force === true)
const opsEnv = parseAssistantOutput(
  '{"reply":"r","ops":[{"id":"abc","action":"done"},{"id":"","action":"done"},{"id":"x","action":"delete"},{"id":"y","action":"ignored"}]}'
)
check(
  'ops 只留合法项（非空 id + done/ignored）',
  opsEnv.ops.length === 2 && opsEnv.ops[0].action === 'done' && opsEnv.ops[1].id === 'y'
)
check('无 ops 字段 → 空数组', parseAssistantOutput('{"reply":"r"}').ops.length === 0)

// ---- resolveAddPicks：来源明确且不跨候选组回落 ----
{
  const prev = [normalizeItem({ title: '旧候选' })]
  const curr = [normalizeItem({ title: '明天提醒我交周报', due_time: '2026-08-24T23:59' })]
  check(
    '同轮创建：无上一轮候选时回落到本轮候选',
    (() => {
      const picks = resolveAddPicks([{ candidate: 1, patch: null, force: false }], null, curr)
      return picks.length === 1 && picks[0].item.title === '明天提醒我交周报' && picks[0].item.due_time === '2026-08-24T23:59'
    })()
  )
  check(
    '确认旧候选：明确 previous 来源',
    resolveAddPicks([{ source: 'previous', candidate: 1, patch: null, force: false }], prev, curr)[0].item.title === '旧候选'
  )
  check(
    '两组同时存在缺来源 → 不添加',
    resolveAddPicks([{ candidate: 2, patch: null, force: false }], prev, [curr[0], normalizeItem({ title: '第二项' })]).length === 0
  )
  check(
    'patch 应用到回落的候选上',
    resolveAddPicks([{ candidate: 1, patch: { due_time: '2026-08-25T09:00' }, force: false }], null, curr)[0].item.due_time === '2026-08-25T09:00'
  )
  check('全部越界 → 空', resolveAddPicks([{ candidate: 5, patch: null, force: false }], prev, curr).length === 0)
}

// ---- applyCandidatePatch ----
const base = normalizeItem({ title: '原标题', due_time: '2026-06-20T09:00', priority: 'low' })
check('改标题', applyCandidatePatch(base, { title: '新标题' }).title === '新标题')
check('空白标题被忽略', applyCandidatePatch(base, { title: '   ' }).title === '原标题')
check('改截止时间', applyCandidatePatch(base, { due_time: '2026-07-01T10:30' }).due_time === '2026-07-01T10:30')
check('截止时间置 null（清空）', applyCandidatePatch(base, { due_time: null }).due_time === null)
check('非法截止时间归 null', applyCandidatePatch(base, { due_time: '不是时间' }).due_time === null)
check('改优先级', applyCandidatePatch(base, { priority: 'high' }).priority === 'high')
check('非法优先级保留原值', applyCandidatePatch(base, { priority: 'bogus' }).priority === 'low')
check('未提及的字段不变', applyCandidatePatch(base, { title: 'x' }).priority === 'low')
check('不改动原对象（纯函数）', (() => { const b = { ...base }; applyCandidatePatch(base, { title: 'z' }); return base.title === b.title })())

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
