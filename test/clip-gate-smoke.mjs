// 纯函数单测：剪贴板自动捕获的省钱/降噪门。运行：npm run test:clipgate
import { decideClipboardParse, decideClipboardFastPath, CLIP_LIMITS } from '../src/shared/clip-gate.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

const NOW = 1_000_000
const base = {
  text: '明天下午三点开组会',
  nowMs: NOW,
  cooldownUntilMs: null,
  lastParseAtMs: null,
  excludedApp: false,
  usesModel: true
}
const d = (o) => decideClipboardParse({ ...base, ...o })

check('正常内容放行', d({}).run === true)

// ---- 来源 App 排除（银行/密码类即使没打 Concealed 标记也不碰）----
check('排除名单 App → 拦住', d({ excludedApp: true }).run === false)
check('排除名单的 reason', d({ excludedApp: true }).reason === 'excluded_app')
check('排除优先于一切', d({ excludedApp: true, text: '明天三点开会' }).run === false)

// ---- 长度门 ----
check('太短 → 拦住', d({ text: '明天' }).run === false)
check('太短的 reason', d({ text: '明天' }).reason === 'too_short')
check(`刚好 ${CLIP_LIMITS.minChars} 字 → 放行`, d({ text: '明天三点开会' }).run === true)
check('全空白视作太短', d({ text: '   \n  ' }).reason === 'too_short')
check('超长 → 拦住（多半是整篇文档）', d({ text: 'x'.repeat(CLIP_LIMITS.maxChars + 1) }).run === false)
check('超长的 reason', d({ text: 'x'.repeat(CLIP_LIMITS.maxChars + 1) }).reason === 'too_long')
check('刚好到上限 → 放行', d({ text: 'x'.repeat(CLIP_LIMITS.maxChars) }).run === true)

// ---- 同内容冷却 ----
check('冷却未到 → 拦住', d({ cooldownUntilMs: NOW + 1 }).run === false)
check('冷却的 reason', d({ cooldownUntilMs: NOW + 1 }).reason === 'cooldown')
check('冷却正好到期 → 放行', d({ cooldownUntilMs: NOW }).run === true)
check('冷却已过 → 放行', d({ cooldownUntilMs: NOW - 1 }).run === true)

// ---- 全局限流（防连续复制把积分刷光）----
check('限流窗口内 → 拦住', d({ lastParseAtMs: NOW - CLIP_LIMITS.minGapMs + 1 }).run === false)
check('限流的 reason', d({ lastParseAtMs: NOW - 1 }).reason === 'rate_limited')
check('限流正好到期 → 放行', d({ lastParseAtMs: NOW - CLIP_LIMITS.minGapMs }).run === true)
check('从未解析过 → 放行', d({ lastParseAtMs: null }).run === true)

// ---- 门的优先级：先便宜的判定，后贵的 ----
check('超长 + 冷却 → 报长度（先判便宜的）', d({ text: 'x'.repeat(99999), cooldownUntilMs: NOW + 1 }).reason === 'too_long')

// ---- 限流只针对花钱的模型调用 ----
check(
  '本地快路不受全局限流约束（不花积分）',
  decideClipboardParse({ ...base, lastParseAtMs: NOW - 1, usesModel: false }).run === true
)
check(
  '本地快路仍受排除名单约束（隐私门）',
  decideClipboardParse({ ...base, excludedApp: true, usesModel: false }).run === false
)
check(
  '本地快路仍受同内容冷却约束（别重复弹）',
  decideClipboardParse({ ...base, cooldownUntilMs: NOW + 1, usesModel: false }).run === false
)

// ---- 本地快路判定 ----
const FAST_NOW = new Date(2026, 7, 24, 16, 48).getTime() // 2026-08-24 16:48 本地
const f = (o) => decideClipboardFastPath({ text: '明天下午三点开组会', nowMs: FAST_NOW, ...o })

check('没有本地时间 → 回落模型', f({}).fast === false)
check('没有本地时间的 reason', f({}).reason === 'no_local_time')

const ok = f({ startIso: '2026-08-25T15:00', allDay: false })
check('有时间且够短 → 走快路', ok.fast === true)
check('标题取复制的原文', ok.title === '明天下午三点开组会')
check('时刻原样带出', ok.isoTime === '2026-08-25T15:00')
check('非全天 → 当作开始时间', ok.deadline === false)

const allDay = decideClipboardFastPath({
  text: '周五前把论文发给张磊老师',
  startIso: '2026-08-28T12:00',
  allDay: true,
  nowMs: FAST_NOW
})
check('全天 → 当作截止', allDay.fast === true && allDay.deadline === true)
check('全天的截止归到当日 23:59（「周五前」不该中午就逾期）', allDay.isoTime === '2026-08-28T23:59')

check(
  '多行 → 回落模型（可能是多条待办）',
  f({ text: '明天三点开会\n周五前交论文', startIso: '2026-08-25T15:00' }).reason === 'multiline'
)
check(
  '过长 → 回落模型',
  f({ text: '开会 '.repeat(40), startIso: '2026-08-25T15:00' }).reason === 'too_complex'
)
check('首尾空白不影响判定', f({ text: '  明天下午三点开组会  ', startIso: '2026-08-25T15:00' }).fast === true)

// ---- 过去时刻 = 检测器把日期漏了、用今天补齐（实测「下月三号上午十点」→ 今天 10:00）----
check(
  '解出的时刻在过去 → 回落模型，不硬记',
  f({ text: '下月三号上午十点去看牙医', startIso: '2026-08-24T10:00' }).reason === 'past_time'
)
check(
  '今天稍晚仍走快路',
  f({ text: '今天下午六点开会', startIso: '2026-08-24T18:00' }).fast === true
)
check(
  '全天当日按 23:59 算，当天仍算未来',
  decideClipboardFastPath({ text: '今天交作业', startIso: '2026-08-24T09:00', allDay: true, nowMs: FAST_NOW }).fast === true
)
check(
  '昨天的全天 → 回落',
  decideClipboardFastPath({ text: '昨天交作业', startIso: '2026-08-23T09:00', allDay: true, nowMs: FAST_NOW }).reason === 'past_time'
)
check('时刻无法解析 → 回落', f({ startIso: '不是时间' }).reason === 'past_time')
check('标题会去掉首尾空白', f({ text: '  明天下午三点开组会  ', startIso: '2026-08-25T15:00' }).title === '明天下午三点开组会')

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)
