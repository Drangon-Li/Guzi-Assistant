// 纯函数单测：local-model-schema（schema 形状 / coerce 校验 / 升级判定 / 去重）。
// 候选/日期/时间/分类提示词的测试在 screen-foreground-smoke.mjs。
// 运行：node test/local-model-smoke.mjs
import {
  EXTRACTION_JSON_SCHEMA,
  coerceExtractions,
  dedupeExtractions,
  shouldEscalate
} from '../src/shared/local-model-schema.ts'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) pass++
  else {
    fail++
    console.error('FAIL:', name)
  }
}

// ---- schema：顶层数组、items 七字段、无 minItems ----
check('schema 顶层为 array', EXTRACTION_JSON_SCHEMA.type === 'array')
check('schema 无 minItems（允许空）', EXTRACTION_JSON_SCHEMA.minItems === undefined)
check('items 含 title', !!EXTRACTION_JSON_SCHEMA.items.properties.title)
check('items 含 needsVlm', !!EXTRACTION_JSON_SCHEMA.items.properties.needsVlm)

// ---- coerce：合法对象通过 + 派生 strong ----
const ok = coerceExtractions([
  {
    title: '组会',
    isoTime: '2026-06-26T15:00',
    deadline: false,
    belongsToUser: 'yes',
    hits: ['组会'],
    confidence: 0.9,
    needsVlm: false
  }
])
check('合法对象保留 1 条', ok.length === 1)
check('有日期 → strong=true', ok[0].strong === true)
check('isoTime 透传', ok[0].isoTime === '2026-06-26T15:00')

// ---- coerce：无日期 → strong=false ----
const noDate = coerceExtractions([
  {
    title: 'x',
    isoTime: null,
    deadline: false,
    belongsToUser: 'uncertain',
    hits: [],
    confidence: 0.5,
    needsVlm: true
  }
])
check('无日期 → strong=false', noDate[0].strong === false)

// ---- coerce：非法日历日期（2026-13-45）→ isoTime null、strong false（不编造）----
const badDate = coerceExtractions([
  {
    title: '坏日期',
    isoTime: '2026-13-45T99:99',
    deadline: false,
    belongsToUser: 'yes',
    hits: [],
    confidence: 0.9,
    needsVlm: false
  }
])
check('非法日期 → isoTime null', badDate[0].isoTime === null)
check('非法日期 → strong false', badDate[0].strong === false)
const goodDate = coerceExtractions([
  {
    title: '好日期',
    isoTime: '2026-02-28T09:30',
    deadline: false,
    belongsToUser: 'yes',
    hits: [],
    confidence: 0.9,
    needsVlm: false
  }
])
check('合法日期保留 + strong', goodDate[0].isoTime === '2026-02-28T09:30' && goodDate[0].strong === true)

// ---- coerce：脏数据丢弃 + 置信度夹紧 + 缺字段补默认 ----
check('非数组 → []', coerceExtractions(null).length === 0)
check('空数组 → []', coerceExtractions([]).length === 0)
check('无 title → 丢弃', coerceExtractions([{ isoTime: null }]).length === 0)
const clamp = coerceExtractions([
  {
    title: 'a',
    isoTime: null,
    deadline: false,
    belongsToUser: 'bad',
    hits: 'x',
    confidence: 9,
    needsVlm: 1
  }
])
check('置信度夹到 1', clamp[0].confidence === 1)
check('非法 belongsToUser → uncertain', clamp[0].belongsToUser === 'uncertain')
check('hits 非数组 → []', Array.isArray(clamp[0].hits) && clamp[0].hits.length === 0)
check('needsVlm 强转 bool', clamp[0].needsVlm === true)

// ---- shouldEscalate：needsVlm 或低置信 ----
check('needsVlm=true → 升级', shouldEscalate({ needsVlm: true, confidence: 0.99 }, 0.6) === true)
check('低置信 → 升级', shouldEscalate({ needsVlm: false, confidence: 0.3 }, 0.6) === true)
check('高置信且不需 → 不升级', shouldEscalate({ needsVlm: false, confidence: 0.8 }, 0.6) === false)

// ---- dedupeExtractions ----
const mk = (title, iso, conf) => ({
  title,
  isoTime: iso,
  strong: true,
  confidence: conf,
  deadline: false,
  belongsToUser: 'yes',
  hits: [],
  needsVlm: false
})
check(
  '同标题同时间合一',
  dedupeExtractions([mk('会', '2026-06-26T09:00', 0.9), mk('会', '2026-06-26T09:00', 0.8)]).length === 1
)
check(
  '不同时间不合并',
  dedupeExtractions([mk('会', '2026-06-26T09:00', 0.9), mk('会', '2026-06-27T09:00', 0.9)]).length === 2
)

console.log(`local-model-smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
