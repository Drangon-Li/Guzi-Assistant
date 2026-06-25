# 屏幕感知本地小模型重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用本地文本小模型（Qwen2.5-1.5B-Instruct）替换屏幕感知里的「关键词白名单 + 时间正则」检测层，低置信自动升级云端 VLM，用户可开关并释放内存。

**Architecture:** 纯逻辑（schema / prompt / 校验 / 升级判定）下沉 `src/shared`（可 .mjs 单测）；node-llama-cpp 封装收敛进 `src/main/local-model/` 单模块；`screenwatch.ts` 保留 pHash/OCR/去重/隐私门等廉价前置，只把规则判断换成 `extractor.extract()`，按 `needsVlm`/置信度自动走现有 VLM 网关。

**Tech Stack:** Electron 38 + electron-vite 4 + React 19 + TypeScript 5.9 + better-sqlite3 + **node-llama-cpp（新增，仅主进程）** + Qwen2.5-1.5B-Instruct GGUF（Q5_K_M，运行时下载到 userData）。

## Global Constraints

- 仅 macOS；node-llama-cpp 只能在主进程用，渲染层经 IPC（官方约束）。
- IPC 通道三处一致：`src/shared/ipc-channels.ts` 注册 + preload 白名单（自动派生）+ 渲染层调用；`test/ipc-channels-smoke.mjs` 守门。
- 测试用 `node test/*-smoke.mjs`（Node 原生 strip-types 直跑 .ts）；**只有 `src/shared` 可被测试 import**，`src/main`（带 electron/native）不可。
- 量化 Q5_K_M（1.29GB）；context 显式 512–1024；模型常驻、用完即卸（`await model.dispose()`，必须 await）；grammar 输出顶层数组、空=`[]`、不加 `minItems`；prompt 正文必须写「无则返回空、勿编造」。
- `screenSenseLocalModel` 默认 `false`（opt-in，因要下模型）；关闭=停监控+卸模型。
- 设置项 DB 列只停用不删（迁移安全）；不写无用注释；不过度防御。
- 不跳过 hooks；提交信息用中文 conventional commits（`feat(screen-sense): …`）。

---

## File Structure

**新建：**
- `src/shared/local-model-schema.ts` — 纯逻辑：`LocalExtraction` 校验/强转、抽取 JSON schema、prompt 构建、`pickBestExtraction`、`shouldEscalate`。零依赖、可单测。
- `src/main/local-model/paths.ts` — 模型 URI / 文件名 / userData 目录 / 路径。
- `src/main/local-model/extractor.ts` — node-llama-cpp 封装：下载 / 加载 / warmup / extract / 卸载 / idle。依赖收敛于此。
- `test/local-model-smoke.mjs` — `local-model-schema.ts` 的纯函数单测。

**修改：**
- `src/shared/types.ts` — 加 `LocalExtraction`、`AppSettings.screenSenseLocalModel`；删 `screenSenseKeywords`。
- `src/shared/ipc-channels.ts` — 加 `localmodel:status` / `localmodel:download` / `eshell:localmodel-progress`。
- `src/main/db.ts` — 设置默认：加 `screenSenseLocalModel:false`，去 `screenSenseKeywords`。
- `src/main/screenwatch.ts` — 用 extractor 替换 `detectLocalSchedule`；自动 VLM 升级；`buildLocalItem`/`acceptLocal` 迁 `LocalExtraction`；生命周期接 load/unload + idle。
- `src/main/ipc.ts` — 注册新通道；`settings:save` 条件加 `screenSenseLocalModel`。
- `src/renderer/src/api.ts` — `acceptLocal` 入参迁 `LocalExtraction`；加 `localModelStatus` / `downloadLocalModel`。
- `src/renderer/src/pages/PreviewCard.tsx` — `LocalSchedule` → `LocalExtraction`。
- `src/renderer/src/pages/Settings.tsx` — 删关键词输入 UI；加本地模型开关 + 下载进度 + 状态。
- `package.json` — 加 `node-llama-cpp` 依赖；`test:unit` 链替换 `local-extract` 为 `local-model`。

**删除：**
- `src/shared/local-extract.ts`、`test/local-extract-smoke.mjs`。
- `src/shared/keywords.ts` 中 `DEFAULT_SCREEN_KEYWORDS` + `matchKeywords`（保留 `DEFAULT_MONITORED_APPS`）。
- `test/screen-smoke.mjs` 中关键词相关断言。

---

## Phase A — 纯逻辑核心（shared/，TDD，无新依赖）

### Task 1: LocalExtraction 类型 + 抽取 schema + 校验/选优/升级判定

**Files:**
- Modify: `src/shared/types.ts`（加 `LocalExtraction`）
- Create: `src/shared/local-model-schema.ts`
- Test: `test/local-model-smoke.mjs`

**Interfaces:**
- Produces:
  - `interface LocalExtraction { title: string; isoTime: string | null; deadline: boolean; belongsToUser: Belongs; hits: string[]; confidence: number; needsVlm: boolean; strong: boolean }`
  - `const EXTRACTION_JSON_SCHEMA`（grammar 用，顶层数组）
  - `coerceExtractions(raw: unknown, now?: Date): LocalExtraction[]`
  - `pickBestExtraction(items: LocalExtraction[]): LocalExtraction | null`
  - `shouldEscalate(e: LocalExtraction, confMin: number): boolean`

- [ ] **Step 1: 在 `src/shared/types.ts` 末尾加类型**

```ts
/** 本地小模型单次抽取结果（替代旧 LocalSchedule）。strong 由 coerce 派生，模型不输出。 */
export interface LocalExtraction {
  title: string
  /** YYYY-MM-DDTHH:mm；解不出为 null（绝不编造） */
  isoTime: string | null
  deadline: boolean
  belongsToUser: Belongs
  /** 命中信号词（填 DetectionRecord.hits） */
  hits: string[]
  confidence: number
  /** 模型自判：要不要上云 VLM 复核 */
  needsVlm: boolean
  /** 派生：解析出了具体日期时间 → 决定是否主动弹卡 */
  strong: boolean
}
```

- [ ] **Step 2: 写失败测试 `test/local-model-smoke.mjs`**

```js
// 纯函数单测：local-model-schema（schema 形状 / coerce 校验 / 选优 / 升级判定）。
// 运行：node test/local-model-smoke.mjs
import {
  EXTRACTION_JSON_SCHEMA,
  coerceExtractions,
  pickBestExtraction,
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

// schema：顶层数组、items 七字段、无 minItems
check('schema 顶层为 array', EXTRACTION_JSON_SCHEMA.type === 'array')
check('schema 无 minItems（允许空）', EXTRACTION_JSON_SCHEMA.minItems === undefined)
check('items 含 title', !!EXTRACTION_JSON_SCHEMA.items.properties.title)
check('items 含 needsVlm', !!EXTRACTION_JSON_SCHEMA.items.properties.needsVlm)

// coerce：合法对象通过 + 派生 strong
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

// coerce：无日期 → strong=false
const noDate = coerceExtractions([
  { title: 'x', isoTime: null, deadline: false, belongsToUser: 'uncertain', hits: [], confidence: 0.5, needsVlm: true }
])
check('无日期 → strong=false', noDate[0].strong === false)

// coerce：脏数据丢弃 + 置信度夹紧 + 缺字段补默认
check('非数组 → []', coerceExtractions(null).length === 0)
check('空数组 → []', coerceExtractions([]).length === 0)
check('无 title → 丢弃', coerceExtractions([{ isoTime: null }]).length === 0)
const clamp = coerceExtractions([
  { title: 'a', isoTime: null, deadline: false, belongsToUser: 'bad', hits: 'x', confidence: 9, needsVlm: 1 }
])
check('置信度夹到 1', clamp[0].confidence === 1)
check('非法 belongsToUser → uncertain', clamp[0].belongsToUser === 'uncertain')
check('hits 非数组 → []', Array.isArray(clamp[0].hits) && clamp[0].hits.length === 0)
check('needsVlm 强转 bool', clamp[0].needsVlm === true)

// pickBest：优先 strong，再比置信度
const best = pickBestExtraction([
  { title: 'weak', isoTime: null, strong: false, confidence: 0.95, deadline: false, belongsToUser: 'yes', hits: [], needsVlm: false },
  { title: 'strong', isoTime: '2026-06-26T09:00', strong: true, confidence: 0.6, deadline: false, belongsToUser: 'yes', hits: [], needsVlm: false }
])
check('pickBest 优先 strong', best.title === 'strong')
check('空输入 → null', pickBestExtraction([]) === null)

// shouldEscalate：needsVlm 或低置信
check('needsVlm=true → 升级', shouldEscalate({ needsVlm: true, confidence: 0.99 }, 0.6) === true)
check('低置信 → 升级', shouldEscalate({ needsVlm: false, confidence: 0.3 }, 0.6) === true)
check('高置信且不需 → 不升级', shouldEscalate({ needsVlm: false, confidence: 0.8 }, 0.6) === false)

console.log(`local-model-smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 3: 运行确认失败**

Run: `node test/local-model-smoke.mjs`
Expected: 报错 `Cannot find module '../src/shared/local-model-schema.ts'` 或断言 FAIL。

- [ ] **Step 4: 实现 `src/shared/local-model-schema.ts`（先不含 prompt，prompt 在 Task 2 加）**

```ts
/**
 * 屏幕感知本地小模型的纯逻辑层：grammar JSON schema、模型输出校验/强转、选优、升级判定。
 * 纯函数、零依赖，可离线单测；不 import 任何 electron/native。
 */
import type { Belongs, LocalExtraction } from './types'

const BELONGS: Belongs[] = ['yes', 'no', 'uncertain']

/** grammar 用 JSON schema：顶层数组，无日程时模型可合法输出 []（不加 minItems，否则逼模型硬编）。 */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      isoTime: { type: ['string', 'null'] },
      deadline: { type: 'boolean' },
      belongsToUser: { enum: ['yes', 'no', 'uncertain'] },
      hits: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
      needsVlm: { type: 'boolean' }
    }
  }
} as const

const clamp01 = (n: unknown): number => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** ISO 含日期（YYYY-MM-DD...）才算 strong。模型应输出完整 ISO 或 null。 */
function hasDate(iso: string | null): boolean {
  return !!iso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)
}

/** 把模型解析出的原始 JSON 强转成干净的 LocalExtraction[]，丢弃无 title 的脏项。绝不编造时间。 */
export function coerceExtractions(raw: unknown, _now: Date = new Date()): LocalExtraction[] {
  if (!Array.isArray(raw)) return []
  const out: LocalExtraction[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    if (!title) continue
    const iso = typeof o.isoTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(o.isoTime) ? o.isoTime.slice(0, 16) : null
    const belongs = BELONGS.includes(o.belongsToUser as Belongs) ? (o.belongsToUser as Belongs) : 'uncertain'
    const hits = Array.isArray(o.hits) ? o.hits.filter((h): h is string => typeof h === 'string') : []
    out.push({
      title: title.slice(0, 80),
      isoTime: iso,
      deadline: o.deadline === true,
      belongsToUser: belongs,
      hits,
      confidence: clamp01(o.confidence),
      needsVlm: o.needsVlm === true || o.needsVlm === 1,
      strong: hasDate(iso)
    })
  }
  return out
}

/** 一帧多事项时挑一条进检测/弹卡：优先 strong，再比置信度。 */
export function pickBestExtraction(items: LocalExtraction[]): LocalExtraction | null {
  if (!items.length) return null
  return [...items].sort((a, b) => Number(b.strong) - Number(a.strong) || b.confidence - a.confidence)[0]
}

/** 是否需要上云 VLM 复核：模型自判 needsVlm 或本地置信度不足。 */
export function shouldEscalate(e: Pick<LocalExtraction, 'needsVlm' | 'confidence'>, confMin: number): boolean {
  return e.needsVlm || e.confidence < confMin
}
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/local-model-smoke.mjs`
Expected: `local-model-smoke: N passed, 0 failed`，退出码 0。

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: 无错误（`LocalExtraction` 已加，schema 模块自洽）。

- [ ] **Step 7: 提交**

```bash
git add src/shared/types.ts src/shared/local-model-schema.ts test/local-model-smoke.mjs
git commit -m "feat(screen-sense): 本地抽取纯逻辑层 — LocalExtraction/schema/coerce/选优/升级判定 + 单测"
```

---

### Task 2: 抽取 prompt 构建（system + user）

**Files:**
- Modify: `src/shared/local-model-schema.ts`（加 prompt 导出）
- Test: `test/local-model-smoke.mjs`（追加 prompt 断言）

**Interfaces:**
- Produces:
  - `const SYSTEM_PROMPT: string`
  - `buildExtractionPrompt(text: string, opts: { now: Date; selfNames?: string[] }): string`

- [ ] **Step 1: 追加失败测试到 `test/local-model-smoke.mjs`（import 行加上新符号，文件末尾 console.log 前插入）**

```js
import { SYSTEM_PROMPT, buildExtractionPrompt } from '../src/shared/local-model-schema.ts'

check('SYSTEM_PROMPT 含「不要编造」约束', /不要编造|勿编造|没有.*返回|空数组|\[\]/.test(SYSTEM_PROMPT))
const p = buildExtractionPrompt('明天下午三点组会', { now: new Date('2026-06-25T10:00:00'), selfNames: ['小李'] })
check('prompt 含 OCR 文本', p.includes('明天下午三点组会'))
check('prompt 含当前时间锚点', p.includes('2026-06-25'))
check('prompt 含自称用于归属', p.includes('小李'))
check('prompt 指示无则返回空', /\[\]|空/.test(p))
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/local-model-smoke.mjs`
Expected: 报错找不到 `SYSTEM_PROMPT` / `buildExtractionPrompt`。

- [ ] **Step 3: 在 `src/shared/local-model-schema.ts` 加 prompt（grammar 不注入 schema，字段含义+空值规则必须写进正文）**

```ts
export const SYSTEM_PROMPT = [
  '你是一个本地日程抽取器。从给定的屏幕文字里抽出"用户需要去做/参加/截止"的待办事项。',
  '只输出 JSON 数组，每个元素字段：',
  '- title: 事项简短标题',
  '- isoTime: 事件时间，格式严格 "YYYY-MM-DDTHH:mm"；解析不出具体日期就填 null，绝不编造',
  '- deadline: 是否截止性质（"前交/截止/DDL"）',
  '- belongsToUser: 这件事是不是用户本人的，取 "yes"/"no"/"uncertain"',
  '- hits: 命中的关键信号词数组（如 "组会"/"考试"）',
  '- confidence: 0~1 的置信度',
  '- needsVlm: 信息不全/拿不准、需要更强模型复核时填 true',
  '规则：屏幕上没有任何明确待办时，必须返回空数组 []；不要编造时间或事项；过去已发生、已取消、不是用户的事降低置信度或标 needsVlm。'
].join('\n')

/** 拼用户消息：当前时间锚点（供相对日期解析）+ 自称（供归属初判）+ OCR 文本。 */
export function buildExtractionPrompt(text: string, opts: { now: Date; selfNames?: string[] }): string {
  const y = opts.now.getFullYear()
  const mo = String(opts.now.getMonth() + 1).padStart(2, '0')
  const d = String(opts.now.getDate()).padStart(2, '0')
  const hh = String(opts.now.getHours()).padStart(2, '0')
  const mm = String(opts.now.getMinutes()).padStart(2, '0')
  const wd = ['日', '一', '二', '三', '四', '五', '六'][opts.now.getDay()]
  const self = opts.selfNames?.filter(Boolean).length ? `用户本人常用称呼：${opts.selfNames.join('、')}。` : ''
  return [
    `当前时间：${y}-${mo}-${d}T${hh}:${mm}（周${wd}），相对日期以此为基准。`,
    self,
    '屏幕文字：',
    '"""',
    text.slice(0, 4000),
    '"""',
    '只返回 JSON 数组，没有待办就返回 []。'
  ]
    .filter(Boolean)
    .join('\n')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node test/local-model-smoke.mjs`
Expected: 全部 passed，0 failed。

- [ ] **Step 5: 提交**

```bash
git add src/shared/local-model-schema.ts test/local-model-smoke.mjs
git commit -m "feat(screen-sense): 抽取 prompt（system+user，含时间锚点/归属/空值约束）+ 单测"
```

---

## Phase B — 本地推理模块（main/，集成验证）

### Task 3: 加 node-llama-cpp 依赖 + 模型路径

**Files:**
- Modify: `package.json`
- Create: `src/main/local-model/paths.ts`

**Interfaces:**
- Produces: `MODEL_URI`、`MODEL_FILENAME`、`modelDir(): string`、`modelPath(): string`、`type LocalModelState`、`interface LocalModelStatus`

- [ ] **Step 1: 安装依赖**

Run: `npm install node-llama-cpp@^3`
Expected: 安装成功；预编译 mac-arm64 二进制随包到位（无需源码编译）。

- [ ] **Step 2: 确认 dev 仍能启动（依赖被 externalize、不破坏构建）**

Run: `npm run dev`（启动后肉眼确认主窗正常出现，然后退出）
Expected: 应用正常启动，无 node-llama-cpp 相关报错。

- [ ] **Step 3: 写 `src/main/local-model/paths.ts`**

```ts
import { app } from 'electron'
import { join } from 'path'

/** node-llama-cpp 的 hf: 解析器：仓库:量化档。Q5_K_M（1.29GB）。 */
export const MODEL_URI = 'hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q5_K_M'
/** HF 该量化档实际文件名（下载后核对，不符则改这里）。 */
export const MODEL_FILENAME = 'qwen2.5-1.5b-instruct-q5_k_m.gguf'

export function modelDir(): string {
  return join(app.getPath('userData'), 'models')
}
export function modelPath(): string {
  return join(modelDir(), MODEL_FILENAME)
}

export type LocalModelState = 'absent' | 'downloading' | 'loading' | 'ready' | 'unloaded' | 'error'
export interface LocalModelStatus {
  state: LocalModelState
  progress?: number
  error?: string
}
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json src/main/local-model/paths.ts
git commit -m "feat(screen-sense): 引入 node-llama-cpp + 模型路径（Qwen2.5-1.5B Q5_K_M，下载到 userData）"
```

---

### Task 4: extractor — 下载 / 加载 / warmup / extract / 卸载 / idle

**Files:**
- Create: `src/main/local-model/extractor.ts`

**Interfaces:**
- Consumes: `paths.ts`；`@shared/local-model-schema`（`EXTRACTION_JSON_SCHEMA`/`SYSTEM_PROMPT`/`buildExtractionPrompt`/`coerceExtractions`）
- Produces: `getLocalModelStatus()`、`downloadLocalModel(onProgress)`、`ensureLoaded()`、`unloadLocalModel()`、`extract(text, selfNames?)`、`touchIdle()`/`startIdleSweep(ms)`

> 集成验证（非 .mjs 单测，因 main/ 含 native）：靠 typecheck + 手动 dev 跑一次真模型。node-llama-cpp 精确 API 以官方文档为准，签名不符时按文档微调。

- [ ] **Step 1: 实现 `src/main/local-model/extractor.ts`**

```ts
import { existsSync } from 'fs'
import { getLlama, LlamaChatSession, createModelDownloader } from 'node-llama-cpp'
import type { Llama, LlamaModel, LlamaJsonSchemaGrammar } from 'node-llama-cpp'
import {
  EXTRACTION_JSON_SCHEMA,
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  coerceExtractions
} from '@shared/local-model-schema'
import type { LocalExtraction } from '@shared/types'
import { MODEL_URI, modelDir, modelPath } from './paths'
import type { LocalModelState, LocalModelStatus } from './paths'

const CONTEXT_SIZE = 1024
const MAX_TOKENS = 1024

let llama: Llama | null = null
let model: LlamaModel | null = null
let grammar: LlamaJsonSchemaGrammar<typeof EXTRACTION_JSON_SCHEMA> | null = null
let state: LocalModelState = 'absent'
let errMsg: string | undefined
let lastUsed = 0

export function getLocalModelStatus(): LocalModelStatus {
  if (state === 'absent' && existsSync(modelPath())) return { state: 'ready' }
  return { state, error: errMsg }
}

async function ensureLlama(): Promise<Llama> {
  if (!llama) llama = await getLlama() // 全局单例，永不 dispose
  return llama
}

/** 首次开启按需下载（带进度）。node-llama-cpp 仅校验文件大小；SHA 固定作为后续 hardening。 */
export async function downloadLocalModel(onProgress: (p: number) => void): Promise<void> {
  if (existsSync(modelPath())) return
  state = 'downloading'
  errMsg = undefined
  try {
    const downloader = await createModelDownloader({
      modelUri: MODEL_URI,
      dirPath: modelDir(),
      onProgress: ({ totalSize, downloadedSize }) =>
        onProgress(totalSize ? downloadedSize / totalSize : 0)
    })
    await downloader.download()
    state = 'ready'
  } catch (e) {
    state = 'error'
    errMsg = e instanceof Error ? e.message : String(e)
    throw e
  }
}

/** lazy load + 一次 warmup 推理消化 mmap 首次延迟。 */
export async function ensureLoaded(): Promise<void> {
  if (model) {
    lastUsed = Date.now()
    return
  }
  if (!existsSync(modelPath())) throw new Error('本地模型尚未下载')
  state = 'loading'
  errMsg = undefined
  try {
    const l = await ensureLlama()
    model = await l.loadModel({ modelPath: modelPath() })
    grammar = await l.createGrammarForJsonSchema(EXTRACTION_JSON_SCHEMA)
    const warm = await model.createContext({ contextSize: CONTEXT_SIZE })
    const s = new LlamaChatSession({ contextSequence: warm.getSequence() })
    await s.prompt('hi', { maxTokens: 1 })
    await warm.dispose()
    state = 'ready'
    lastUsed = Date.now()
  } catch (e) {
    state = 'error'
    errMsg = e instanceof Error ? e.message : String(e)
    model = null
    grammar = null
    throw e
  }
}

/** 关功能 / idle 调：dispose 释放权重+KV，归还统一内存。必须 await，别等 GC。 */
export async function unloadLocalModel(): Promise<void> {
  if (model) await model.dispose() // 级联 dispose 其 context
  model = null
  grammar = null
  if (state !== 'error') state = existsSync(modelPath()) ? 'unloaded' : 'absent'
}

/** 一次抽取：每次新建 context（KV 用完即弃），model 常驻。失败/解析不出返回 []。 */
export async function extract(text: string, selfNames?: string[]): Promise<LocalExtraction[]> {
  if (!text.trim()) return []
  await ensureLoaded()
  lastUsed = Date.now()
  const ctx = await model!.createContext({ contextSize: CONTEXT_SIZE })
  try {
    const session = new LlamaChatSession({
      contextSequence: ctx.getSequence(),
      systemPrompt: SYSTEM_PROMPT
    })
    const res = await session.prompt(buildExtractionPrompt(text, { now: new Date(), selfNames }), {
      grammar: grammar!,
      maxTokens: MAX_TOKENS
    })
    let parsed: unknown
    try {
      parsed = grammar!.parse(res)
    } catch {
      return [] // won't-stop 截断成残缺 JSON → 当作无日程
    }
    return coerceExtractions(parsed)
  } finally {
    await ctx.dispose()
  }
}

let idleTimer: ReturnType<typeof setInterval> | null = null
/** idle 自动卸载：超 ms 未用就卸模型释放内存。screenwatch 在开启功能时启动。 */
export function startIdleSweep(idleMs: number): void {
  stopIdleSweep()
  idleTimer = setInterval(() => {
    if (model && Date.now() - lastUsed > idleMs) void unloadLocalModel()
  }, Math.max(60_000, idleMs / 2))
}
export function stopIdleSweep(): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无错误（若 node-llama-cpp 导出名/签名不符，依官方文档调整 import 与调用，再过 typecheck）。

- [ ] **Step 3: 手动真模型验证（一次性，下载 ~1.3GB）**

临时写 `test/agent-tmp/try-extract.mjs`（该目录已 gitignore）跑：下载 → ensureLoaded → `extract('明天下午三点在三楼会议室组会，记得带笔记本')` → 打印结果 → `unloadLocalModel()`。
Run: `node test/agent-tmp/try-extract.mjs`
Expected: 打印出含 `title`、`isoTime`(2026-06-26T15:00 量级)、`needsVlm` 的 1 条；空文本返回 `[]`；卸载后无报错。**核对** `MODEL_FILENAME` 与实际下载文件名一致（不符则改 `paths.ts`）。

- [ ] **Step 4: 提交（不含临时验证脚本）**

```bash
git add src/main/local-model/extractor.ts
git commit -m "feat(screen-sense): 本地推理 extractor — 下载/加载/warmup/extract/卸载/idle（node-llama-cpp+grammar）"
```

---

## Phase C — 设置与生命周期

### Task 5: AppSettings 加 screenSenseLocalModel / 删 screenSenseKeywords

**Files:**
- Modify: `src/shared/types.ts:124-158`（AppSettings）
- Modify: `src/main/db.ts`（默认值/读取，参考 `:157`、`:191` 附近）
- Modify: `src/main/ipc.ts:101-107`（settings:save 触发条件）

- [ ] **Step 1: `AppSettings` 改字段**：删 `screenSenseKeywords: string[]` 行；加 `/** 本地小模型屏幕感知总开关；关闭=停监控+卸模型省内存。默认 false（opt-in，要下模型） */ screenSenseLocalModel: boolean`。

- [ ] **Step 2: `src/main/db.ts`**：在设置读取里删 `screenSenseKeywords: parseKeywords(...)` 行（`:157` 附近）；在默认值对象加 `screenSenseLocalModel: false`；删除只服务关键词的 `getScreenKeywords`/`DEFAULT_SCREEN_KEYWORDS` import 用法（保留 `DEFAULT_MONITORED_APPS`）。`screenSenseKeywords` 的 DB 列不删（迁移安全）。

- [ ] **Step 3: `src/main/ipc.ts:101-107`**：把 `patch.screenSenseLocalModel !== undefined` 加进触发 `applyScreenSenseSettings()` 的条件。

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: 报错指向仍在用 `screenSenseKeywords` 的 `screenwatch.ts`/`Settings.tsx`（下游任务会清；本步只要 types/db/ipc 自洽，可暂时在 screenwatch 用 `[]` 占位或留待 Task 8）。

> 说明：本步与 Task 8（screenwatch）、Task 10（Settings UI）有交叉引用。执行顺序若先做本步，允许 screenwatch/Settings 暂时编译报错，直到对应任务完成；或按 Phase D/E 顺序推进后回填。**建议把 Step 4 的 typecheck 全绿验证推迟到 Task 8 完成**，本步提交时仅保证 types/db/ipc 三文件改对。

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/main/db.ts src/main/ipc.ts
git commit -m "feat(screen-sense): 设置加 screenSenseLocalModel、停用 screenSenseKeywords + save 触发接线"
```

---

### Task 6: 生命周期接线（开/关 load·unload + idle）

**Files:**
- Modify: `src/main/screenwatch.ts:413-421`（`applyScreenSenseSettings`）

**Interfaces:**
- Consumes: `extractor`（`downloadLocalModel`/`ensureLoaded`/`unloadLocalModel`/`startIdleSweep`/`stopIdleSweep`/`getLocalModelStatus`）

- [ ] **Step 1: 在 `screenwatch.ts` 顶部 import**

```ts
import {
  ensureLoaded as ensureModelLoaded,
  unloadLocalModel,
  startIdleSweep,
  stopIdleSweep,
  getLocalModelStatus
} from './local-model/extractor'
```

- [ ] **Step 2: 改 `applyScreenSenseSettings()`**（把模型生命周期并入现有启停逻辑）

```ts
const IDLE_UNLOAD_MS = 10 * 60 * 1000

export function applyScreenSenseSettings(): void {
  const {
    screenSenseEnabled,
    screenSenseLocalModel,
    screenSenseHotkey,
    screenSenseContinuous,
    screenSenseIntervalSec
  } = getSettings()
  const on = screenSenseEnabled && screenSenseLocalModel
  if (on) initScanHotkey(screenSenseHotkey, () => void scanOnce())
  else unregisterScanHotkey()
  if (on && screenSenseContinuous) startWatch(screenSenseIntervalSec)
  else stopWatch()
  if (on) {
    if (getLocalModelStatus().state === 'ready') void ensureModelLoaded().catch(() => {})
    startIdleSweep(IDLE_UNLOAD_MS)
  } else {
    stopIdleSweep()
    void unloadLocalModel() // 关功能即释放内存
  }
  runShotRetention()
}
```

- [ ] **Step 3: typecheck**（允许 screenwatch 内 detectLocalSchedule 处仍报错，Task 8 清；本步只验证生命周期段类型对——可与 Task 8 合并验证）

- [ ] **Step 4: 提交**

```bash
git add src/main/screenwatch.ts
git commit -m "feat(screen-sense): 生命周期 — 开启 load+idle 巡检、关闭 unload 释放内存"
```

---

## Phase D — IPC + screenwatch 接入

### Task 7: 新增 IPC 通道（状态/下载/进度）

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/ipc.ts`
- Modify: `test/ipc-channels-smoke.mjs`（若它断言计数/具体通道）

**Interfaces:**
- Produces: invoke `localmodel:status` / `localmodel:download`；event `eshell:localmodel-progress`

- [ ] **Step 1: `ipc-channels.ts`**：`INVOKE_CHANNELS` 加 `'localmodel:status'`、`'localmodel:download'`；`EVENT_CHANNELS` 加 `'eshell:localmodel-progress'`。

- [ ] **Step 2: `src/main/ipc.ts`** 注册（在屏幕相关 handler 附近）

```ts
ipcMain.handle('localmodel:status', () => getLocalModelStatus())
ipcMain.handle('localmodel:download', async () => {
  await downloadLocalModel((p) => broadcast('eshell:localmodel-progress', { progress: p }))
  applyScreenSenseSettings()
  return getLocalModelStatus()
})
```
并在顶部 import `getLocalModelStatus`、`downloadLocalModel`（from `./local-model/extractor`）、确保 `applyScreenSenseSettings` 已 import。`broadcast` 已 import。

- [ ] **Step 3: 运行通道一致性测试**

Run: `node test/ipc-channels-smoke.mjs`
Expected: PASS（三处一致）。若测试硬编通道计数，更新之。

- [ ] **Step 4: typecheck + 提交**

```bash
git add src/shared/ipc-channels.ts src/main/ipc.ts test/ipc-channels-smoke.mjs
git commit -m "feat(screen-sense): IPC 通道 localmodel:status/download + 进度事件（三处一致）"
```

---

### Task 8: screenwatch 用 extractor 替换规则 + 自动 VLM 升级

**Files:**
- Modify: `src/main/screenwatch.ts`（`scanOnce` `:55-108`、`watchTick` `:269-390`、`buildLocalItem` `:162-179`、`acceptLocal` `:182-195`、imports）

**Interfaces:**
- Consumes: `extract`（extractor）、`pickBestExtraction`/`shouldEscalate`（schema）、`aiParse`（本文件已有，VLM 升级目标）、`getProfile`（自称）

- [ ] **Step 1: 改 imports**：删 `import { detectLocalSchedule } from '@shared/local-extract'` 与 `import { matchKeywords } from '@shared/keywords'`；加

```ts
import { extract } from './local-model/extractor'
import { pickBestExtraction, shouldEscalate } from '@shared/local-model-schema'
import type { LocalExtraction } from '@shared/types'
import { getProfile } from './db'
```
（`getProfile` 若已在 db import 列表则合并。）

- [ ] **Step 2: 加共用判定函数**（替代旧 detect 调用，含自动升级）

```ts
const CONF_MIN = 0.6

/** OCR 文本 → 本地抽取 → 选最优 → 需要则自动上 VLM 复核。返回可入库的 ParsedItem 与展示用信息，无则 null。 */
async function detectAndMaybeRefine(
  text: string
): Promise<{ extraction: LocalExtraction; item: ParsedItem; refined: boolean } | null> {
  const selfNames = (() => {
    const p = getProfile()
    return p ? [p.name, ...(p.nicknames ?? [])].filter(Boolean) : []
  })()
  const best = pickBestExtraction(await extract(text, selfNames))
  if (!best) return null
  if (shouldEscalate(best, CONF_MIN)) {
    const items = await parseToItems({ text, hint: HINTS.screen_scan })
    const refinedBest = pickBest(items)
    if (refinedBest) return { extraction: best, item: refinedBest, refined: true }
  }
  return { extraction: best, item: buildLocalItem(best), refined: false }
}
```

- [ ] **Step 3: 改 `buildLocalItem` 签名为吃 `LocalExtraction`**

```ts
function buildLocalItem(e: LocalExtraction): ParsedItem {
  return {
    title: e.title,
    item_type: 'other',
    belongs_to_user: e.belongsToUser,
    belonging_reason: '本地模型识别',
    user_role: 'unclear',
    start_time: e.deadline ? null : e.isoTime,
    due_time: e.deadline ? e.isoTime : null,
    location: null,
    priority: 'unknown',
    confidence: e.confidence,
    suggested_action: 'confirm',
    notes: [],
    evidence: [],
    duplicate_of: null
  }
}
```

- [ ] **Step 4: 改 `acceptLocal` 入参为 `{ extraction; sourceText; detectionId? }`**

```ts
export function acceptLocal(payload: {
  extraction: LocalExtraction
  sourceText: string
  detectionId?: string
}): AddedInfo {
  const info = acceptSuggestion({
    item: buildLocalItem(payload.extraction),
    sourceText: payload.sourceText
  })
  if (payload.detectionId) setDetectionStatus(payload.detectionId, 'accepted')
  return info
}
```

- [ ] **Step 5: 改 `scanOnce` 命中段**（`:84-102`）：把 `detectLocalSchedule(text, screenSenseKeywords)` 改为 `await detectAndMaybeRefine(text)`；用返回的 `extraction` 填 `addDetection`（`title`/`isoTime`/`deadline`/`hits` 来自 extraction，`hits: extraction.hits`）；`showPreview({ localSuggestion: { ...extraction, item, sourceText, detectionId } })`。删掉对 `screenSenseKeywords` 的解构。

- [ ] **Step 6: 改 `watchTick` 命中段**（`:337-383`）：同样替换为 `detectAndMaybeRefine`；弹卡门 `extraction.strong && screenSensePopup && 同App`；`addDetection` 用 extraction；删 `screenSenseKeywords` 解构。

- [ ] **Step 7: 改 `aiParse` 的 hits**（`:158`）：`matchKeywords` 已删，改为 `hits: best.hits ?? []`（来自模型 ParsedItem 无 hits 字段，则传 `[]`）。

- [ ] **Step 8: typecheck（此时应全绿）**

Run: `npm run typecheck`
Expected: 无错误（Task 5/6 遗留的 screenSenseKeywords 引用此时已清）。

- [ ] **Step 9: 手动 dev 冒烟**

Run: `npm run dev`，开启设置里的本地模型开关→等下载→在微信/钉钉里发一条"明天下午三点开会"，确认弹检测卡；发一条纯闲聊确认不弹。
Expected: 命中弹卡、无关不弹；调试面板日志正常。

- [ ] **Step 10: 提交**

```bash
git add src/main/screenwatch.ts
git commit -m "feat(screen-sense): 规则判断换本地模型 extract + 低置信自动 VLM 升级"
```

---

## Phase E — 渲染层

### Task 9: PreviewCard + api.ts 迁 LocalExtraction

**Files:**
- Modify: `src/renderer/src/api.ts:70-76`（acceptLocal）
- Modify: `src/renderer/src/pages/PreviewCard.tsx:4,17,83-88,136-138`

- [ ] **Step 1: `api.ts`**：`acceptLocal` 入参类型从旧四字段改为 `{ extraction: LocalExtraction; sourceText: string; detectionId?: string }`；import `LocalExtraction` from `@shared/types`。加 `localModelStatus: () => inv<LocalModelStatus>('localmodel:status')`、`downloadLocalModel: () => inv<LocalModelStatus>('localmodel:download')`（import `LocalModelStatus`——把它从 `paths.ts` 提到 `@shared/types` 更合适，见下注）。

> 注：`LocalModelStatus`/`LocalModelState` 当前在 `src/main/local-model/paths.ts`，渲染层不应 import main。**本步把这两个类型移到 `src/shared/types.ts`**，`paths.ts` 改为 `import type { LocalModelStatus, LocalModelState } from '@shared/types'`。

- [ ] **Step 2: `PreviewCard.tsx`**：`import type { LocalSchedule }` 改 `LocalExtraction`；`local` 联合类型与 `localSuggestion` 形状改为 `LocalExtraction & { item?: ParsedItem; sourceText: string; detectionId?: string }`；`acceptLocalNow` 调 `api.acceptLocal({ extraction, sourceText, detectionId })`（从 localSuggestion 取 extraction）。

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/api.ts src/renderer/src/pages/PreviewCard.tsx src/shared/types.ts src/main/local-model/paths.ts
git commit -m "refactor(screen-sense): 渲染层 LocalSchedule→LocalExtraction + LocalModelStatus 提到 shared"
```

---

### Task 10: Settings 删关键词 UI + 加本地模型开关/下载

**Files:**
- Modify: `src/renderer/src/pages/Settings.tsx`（关键词输入 `:408-416` 段；屏幕感知设置区）

- [ ] **Step 1: 删关键词输入 UI**（`:411-415` 那个 `screenSenseKeywords` 的 textarea/输入及其 label）。

- [ ] **Step 2: 加本地模型开关 + 下载进度**（在屏幕感知设置区）：一个 `screenSenseLocalModel` 开关（调 `api.saveSettings({ screenSenseLocalModel })`）；开关打开且状态非 ready 时显示「下载模型（约 1.3GB）」按钮，点了调 `api.downloadLocalModel()`，订阅 `eshell:localmodel-progress` 显示进度条；用 `api.localModelStatus()` 初始拉状态。文案明确「关闭可释放内存」。

```tsx
// 屏幕感知设置区内新增（示意，套用本页既有 Toggle/按钮组件与样式）
<Row label="本地智能检测" hint="用设备端小模型识别日程；关闭可释放内存（约 1.3GB 模型，首次需下载）">
  <Toggle
    checked={settings.screenSenseLocalModel}
    onChange={async (v) => {
      setSettings({ ...settings, screenSenseLocalModel: v })
      await api.saveSettings({ screenSenseLocalModel: v })
      if (v) refreshModelStatus()
    }}
  />
</Row>
{settings.screenSenseLocalModel && modelState !== 'ready' && (
  <ModelDownloadRow state={modelState} progress={dlProgress} onDownload={() => void api.downloadLocalModel()} />
)}
```
（`modelState`/`dlProgress` 用 `useState` + `useEffect` 订阅 `api.on('eshell:localmodel-progress', …)` 与初始 `api.localModelStatus()`；`Row`/`Toggle` 用本页既有同款组件。）

- [ ] **Step 3: typecheck + dev 目视**

Run: `npm run typecheck` 然后 `npm run dev`
Expected: 设置页无关键词输入框；出现本地模型开关；打开→显示下载按钮→进度→ready。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/pages/Settings.tsx
git commit -m "feat(screen-sense): 设置页删关键词、加本地模型开关 + 下载进度（关闭释放内存）"
```

---

## Phase F — 清理与收尾

### Task 11: 删旧规则代码 + 测试归零 + 全绿

**Files:**
- Delete: `src/shared/local-extract.ts`、`test/local-extract-smoke.mjs`
- Modify: `src/shared/keywords.ts`（删 `DEFAULT_SCREEN_KEYWORDS`、`matchKeywords`；留 `DEFAULT_MONITORED_APPS`）
- Modify: `test/screen-smoke.mjs`（删关键词断言）
- Modify: `package.json:38`（`test:unit` 链：去 `local-extract-smoke`，加 `local-model-smoke`）

- [ ] **Step 1: 确认无残留引用**

Run: `grep -rn "detectLocalSchedule\|local-extract\|matchKeywords\|DEFAULT_SCREEN_KEYWORDS\|screenSenseKeywords" src/ test/`
Expected: 仅剩 `keywords.ts`/被删文件自身（应为空，否则先清引用）。

- [ ] **Step 2: 删文件 + 改 keywords.ts + 改 screen-smoke.mjs + 改 package.json test:unit 链**。

- [ ] **Step 3: 跑全量单测**

Run: `npm run test:unit`
Expected: 全绿（含新 `local-model-smoke`，无 `local-extract`）。

- [ ] **Step 4: 全量 typecheck**

Run: `npm run typecheck`
Expected: 两个 tsconfig 均无错误。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(screen-sense): 删 local-extract/关键词门/旧测试，test:unit 切到 local-model"
```

---

## Phase G — 部署（文档化，暂不阻塞）

### Task 12: 打包 / 公证 follow-up（仅文档，不实施）

项目当前无 electron-builder 配置（跑法是 `npm run dev`）。正式分发时需新建打包配置并处理 node-llama-cpp 原生二进制：

- [ ] 抄官方 `electron-typescript-react` 模板的 `asarUnpack` 三条 glob（`node-llama-cpp/bins`、`llama/localBuilds`、`@node-llama-cpp/*`），`files` 只挑 `${os}-${arch}` 二进制。
- [ ] electron-builder `mac.notarize/hardenedRuntime` + entitlements（`allow-jit`、`allow-unsigned-executable-memory`）；**unpack 后二进制才能被 codesign，漏签整体公证失败**。
- [ ] 给 `downloadLocalModel` 补 SHA256 校验（node-llama-cpp 仅校验文件大小）：首次下载后记录该 GGUF 的 sha256 并固定。
- [ ] 与现有 `postinstall: electron-rebuild`（better-sqlite3）共存验证。

记入 issue，本次重构不实施。

---

## Self-Review

- **Spec 覆盖**：删规则(Task 8/11) / 保留 OCR·pHash·隐私门(未动) / 本地模型 extract(Task 4) / 自动 VLM 升级(Task 8) / 设置开关+省内存(Task 5/6/10) / 按需下载(Task 4/10) / Q5_K_M(Task 3) / 反幻觉 schema(Task 1/2) / IPC 三处一致(Task 7) / 删留清单(Task 11) / 部署优化(Task 12 文档) — 均有对应任务。
- **占位扫描**：无 TBD；SHA 校验明确列为 Task 12 hardening（非含糊占位）；MODEL_FILENAME 有「下载后核对」实证步骤。
- **类型一致**：`LocalExtraction`(7 模型字段 + 派生 strong)贯穿 schema→extractor→screenwatch→PreviewCard；`acceptLocal` 入参在 ipc.ts(Task 待改)/api.ts(Task 9)/PreviewCard(Task 9)统一为 `{extraction,sourceText,detectionId?}`；`LocalModelStatus` 由 paths→shared(Task 9)。
- **已知交叉**：Task 5/6 改动会让 screenwatch/Settings 暂时编译报错，至 Task 8/10 收口；执行时按 Phase 顺序即可，typecheck 全绿验证以 Task 8、Task 11 为准。

> ⚠️ Task 8 修改 ipc.ts 的 `suggestion:accept-local` handler 入参（`acceptLocal` 签名变了）：在 Task 8 Step 4 同时改 `src/main/ipc.ts:203-215` 的 handler 形状为 `{ extraction, sourceText, detectionId? }`。
