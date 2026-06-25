// 纯函数单测：local-model-schema（schema 形状 / coerce 校验 / 选优 / 升级判定 / prompt）。
// 运行：node test/local-model-smoke.mjs
import {
  EXTRACTION_JSON_SCHEMA,
  coerceExtractions,
  chunkForExtraction,
  dedupeExtractions,
  pickBestExtraction,
  shouldEscalate,
  SYSTEM_PROMPT,
  buildExtractionPrompt
} from '../src/shared/local-model-schema.ts'
import { resolveLocalDate, correctIsoDate } from '../src/shared/local-time.ts'

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

// ---- pickBest：优先 strong，再比置信度 ----
const best = pickBestExtraction([
  {
    title: 'weak',
    isoTime: null,
    strong: false,
    confidence: 0.95,
    deadline: false,
    belongsToUser: 'yes',
    hits: [],
    needsVlm: false
  },
  {
    title: 'strong',
    isoTime: '2026-06-26T09:00',
    strong: true,
    confidence: 0.6,
    deadline: false,
    belongsToUser: 'yes',
    hits: [],
    needsVlm: false
  }
])
check('pickBest 优先 strong', best.title === 'strong')
check('空输入 → null', pickBestExtraction([]) === null)

// ---- shouldEscalate：needsVlm 或低置信 ----
check('needsVlm=true → 升级', shouldEscalate({ needsVlm: true, confidence: 0.99 }, 0.6) === true)
check('低置信 → 升级', shouldEscalate({ needsVlm: false, confidence: 0.3 }, 0.6) === true)
check('高置信且不需 → 不升级', shouldEscalate({ needsVlm: false, confidence: 0.8 }, 0.6) === false)

// ---- chunkForExtraction：去重 + 切块 + 上限 ----
const longText = Array.from({ length: 40 }, (_, i) => `第${i}行内容长一些占点字数`).join('\n')
check('长文本切多块', chunkForExtraction(longText, 14, 600, 12).length > 1)
check('块数不超上限', chunkForExtraction(longText, 2, 50, 3).length <= 3)
check('短文本单块', chunkForExtraction('明天下午三点开会').length === 1)
const dedupChunk = chunkForExtraction('开会\n开会\n开会').join('')
check('重复行去重', (dedupChunk.match(/开会/g) || []).length === 1)
const prefixChunk = chunkForExtraction('对方：明天开会\n明天开会').join('')
check('归一化前缀去重', (prefixChunk.match(/明天开会/g) || []).length === 1)

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

// ---- 确定性日期解析 + 纠错（now = 2026-06-25 周四）----
const TNOW = new Date('2026-06-25T10:00:00')
const ymd = (o) => (o ? `${o.y}-${o.mo}-${o.d}` : null)
check('明天 → 06-26', ymd(resolveLocalDate('明天上午开会', TNOW)) === '2026-6-26')
check('下周一 → 06-29', ymd(resolveLocalDate('下周一交方案', TNOW)) === '2026-6-29')
check('后天 → 06-27', ymd(resolveLocalDate('后天答辩', TNOW)) === '2026-6-27')
check('6月30日 → 06-30', ymd(resolveLocalDate('考试 6月30日', TNOW)) === '2026-6-30')
check('显式 ISO', ymd(resolveLocalDate('于 2026-07-05 参加', TNOW)) === '2026-7-5')
check('无日期 → null', resolveLocalDate('看一下是否一致', TNOW) === null)
check('中文数字日期解析器搞不定 → null', resolveLocalDate('六月八号', TNOW) === null)
check(
  '纠正下周一错算的日期、保留钟点',
  correctIsoDate('2026-07-01T15:00', '下周一下午三点开会', TNOW) === '2026-06-29T15:00'
)
check('日期一致不动', correctIsoDate('2026-06-26T09:00', '明天开会', TNOW) === '2026-06-26T09:00')
check('模型无时间不臆造', correctIsoDate(null, '下周一', TNOW) === null)
check(
  '解析器搞不定则保留模型值',
  correctIsoDate('2026-06-26T09:00', '六月八号开会', TNOW) === '2026-06-26T09:00'
)

// ---- prompt ----
check('SYSTEM_PROMPT 含「不要编造/空」约束', /不要编造|勿编造|没有.*返回|空数组|\[\]/.test(SYSTEM_PROMPT))
const p = buildExtractionPrompt('明天下午三点组会', {
  now: new Date('2026-06-25T10:00:00'),
  selfNames: ['小李']
})
check('prompt 含 OCR 文本', p.includes('明天下午三点组会'))
check('prompt 含当前时间锚点', p.includes('2026-06-25'))
check('prompt 含自称用于归属', p.includes('小李'))
check('prompt 指示无则返回空', /\[\]|空/.test(p))

console.log(`local-model-smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
