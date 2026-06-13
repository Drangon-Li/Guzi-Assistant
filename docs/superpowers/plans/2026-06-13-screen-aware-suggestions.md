# 屏幕感知建议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 al1 加一个默认关闭的隐私功能：手动触发"扫描当前屏幕"，本地 OCR 出文字 → 命中关键词 → 只把文字送解析 → 右下角弹出一条待办建议（同意/拒绝/修改），截图用完即弃。

**Architecture:** 新增 `ocr.ts`（内嵌 Swift + swiftc 编译缓存调 Apple Vision）、`screenwatch.ts`（编排截图→OCR→解析→选最优→弹卡）、两个 shared 纯函数模块（`keywords.ts` 关键词匹配、`suggest.ts` 选最优）。建议卡复用现有右下角预览窗（`showPreview` 已接受任意 payload，无需改 `windows.ts`）。入口为助手页按钮 + 全局快捷键，由设置页 opt-in 开关控制。

**Tech Stack:** Electron + React 19 + TypeScript + better-sqlite3 + Tailwind v4；本地 OCR 用 macOS Apple Vision（`VNRecognizeTextRequest`）经内嵌 Swift CLI；解析复用现有 `/v1/responses` 链路。

设计依据：`docs/superpowers/specs/2026-06-13-screen-aware-suggestions-design.md`

---

## 文件结构

| 文件 | 职责 | 新增/改 |
|---|---|---|
| `src/shared/keywords.ts` | 默认关键词表 + `matchKeywords` 纯函数 | 新增 |
| `src/shared/suggest.ts` | `pickBest` 选最优纯函数 | 新增 |
| `src/shared/types.ts` | `AppSettings` 三字段 + `SourceType` 加 `screen_scan` + `ScanResult` | 改 |
| `src/renderer/src/labels.ts` | `SOURCE_LABELS.screen_scan` | 改 |
| `src/main/db.ts` | `getSettings/saveSettings` 读写三字段 | 改 |
| `src/main/capture.ts` | `HINTS.screen_scan`（导出 HINTS）+ `captureScreenSilently` | 改 |
| `src/main/ocr.ts` | 内嵌 Swift + 编译缓存 + `ocrImage` | 新增 |
| `src/main/screenwatch.ts` | `scanOnce` / `acceptSuggestion` / `applyScreenSenseSettings` / Phase2 空壳 | 新增 |
| `src/main/hotkey.ts` | 内部改具名注册表；新增 scan 快捷键函数（原有签名不变）| 改 |
| `src/main/ipc.ts` | `screen:scan` / `suggestion:accept`；settings:save 触发 `applyScreenSenseSettings` | 改 |
| `src/main/index.ts` | 启动时 `applyScreenSenseSettings()` | 改 |
| `src/renderer/src/api.ts` | `screenScan` / `suggestionAccept` | 改 |
| `src/renderer/src/pages/PreviewCard.tsx` | 新增 `suggestion` / `done` phase | 改 |
| `src/renderer/src/pages/Assistant.tsx` | "扫描屏幕"按钮（开启时显示）| 改 |
| `src/renderer/src/pages/Settings.tsx` | "屏幕感知建议"设置区 | 改 |
| `test/screen-smoke.mjs` | `matchKeywords` / `pickBest` 单测 | 新增 |
| `package.json` | `test:screen` 脚本 | 改 |

---

## Task 1: 关键词匹配纯函数（TDD）

**Files:**
- Create: `src/shared/keywords.ts`
- Create: `test/screen-smoke.mjs`
- Modify: `package.json`（scripts 增加 `test:screen`）

- [ ] **Step 1: 写失败的测试** — 创建 `test/screen-smoke.mjs`

```js
// 纯函数单测：关键词匹配 + 选最优。运行：npm run test:screen
import { matchKeywords, DEFAULT_SCREEN_KEYWORDS } from '../src/shared/keywords.ts'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// ---- matchKeywords ----
check('命中单个关键词', matchKeywords('明天下午开会议', ['会议']).join() === '会议')
check('多关键词去重命中', JSON.stringify(matchKeywords('会议和考试通知，考试很重要', ['会议', '考试'])) === JSON.stringify(['会议', '考试']))
check('英文大小写不敏感', matchKeywords('Project DEADLINE today', ['deadline']).join() === 'deadline')
check('未命中返回空数组', matchKeywords('今天天气不错', ['会议', '考试']).length === 0)
check('默认词表非空', DEFAULT_SCREEN_KEYWORDS.length > 0)
check('默认词表含会议/日程/考试', ['会议', '日程', '考试'].every((k) => DEFAULT_SCREEN_KEYWORDS.includes(k)))

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
if (failed) process.exit(1)
```

并在 `package.json` 的 `scripts` 里，紧跟 `"test:parser"` 后加一行：

```json
    "test:screen": "node test/screen-smoke.mjs",
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd al1 && npm run test:screen`
Expected: FAIL —— 报 `Cannot find module ... src/shared/keywords.ts` 或导入错误。

- [ ] **Step 3: 实现** — 创建 `src/shared/keywords.ts`

```ts
/** 屏幕感知建议的默认触发关键词；用户可在设置页增删 */
export const DEFAULT_SCREEN_KEYWORDS = [
  '会议',
  '日程',
  '考试',
  '截止',
  'deadline',
  'ddl',
  '报名',
  '面试',
  '笔试',
  '作业',
  '答辩',
  '讲座',
  '预约',
  '缴费',
  '提交',
  '通知',
  '签到',
  '面谈',
  '活动'
]

/** 返回 text 中命中的关键词（去重，大小写不敏感） */
export function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase()
  const hits: string[] = []
  for (const kw of keywords) {
    const k = kw.trim()
    if (k && lower.includes(k.toLowerCase()) && !hits.includes(k)) hits.push(k)
  }
  return hits
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd al1 && npm run test:screen`
Expected: PASS —— "全部通过"。
（若报错为 Node 不支持直接 import .ts：本仓库现有 `test:parser` 用同样方式运行，需 Node ≥ 22.6 的类型剥离；确认 Node 版本与 `npm run test:parser` 一致即可。）

- [ ] **Step 5: 提交**

```bash
cd al1 && git add src/shared/keywords.ts test/screen-smoke.mjs package.json
git commit -m "feat(screen): 关键词匹配纯函数 + 默认词表"
```

---

## Task 2: 选最优纯函数 pickBest（TDD）

**Files:**
- Create: `src/shared/suggest.ts`
- Modify: `test/screen-smoke.mjs`

- [ ] **Step 1: 写失败的测试** — 在 `test/screen-smoke.mjs` 顶部 import 行后追加 import，并在 `console.log(failed ...)` 之前追加用例

在文件顶部 import 区追加：

```js
import { pickBest, SUGGEST_MIN_CONFIDENCE } from '../src/shared/suggest.ts'

function mkItem(o) {
  return {
    title: 't',
    item_type: 'other',
    belongs_to_user: 'yes',
    belonging_reason: '',
    user_role: 'unclear',
    start_time: null,
    due_time: null,
    location: null,
    priority: 'unknown',
    confidence: 0.9,
    suggested_action: 'confirm',
    evidence: [],
    notes: [],
    duplicate_of: null,
    ...o
  }
}
```

在 `console.log(failed ...)` 之前追加：

```js
// ---- pickBest ----
check('空数组返回 null', pickBest([]) === null)
check('全部 belongs=no 返回 null', pickBest([mkItem({ belongs_to_user: 'no', title: 'x' })]) === null)
check(
  '挑置信度最高的 yes',
  pickBest([
    mkItem({ title: 'low', confidence: 0.5 }),
    mkItem({ title: 'high', confidence: 0.95 })
  ])?.title === 'high'
)
check(
  'yes 优先于 uncertain（即使 uncertain 置信度更高）',
  pickBest([
    mkItem({ title: 'unc', belongs_to_user: 'uncertain', confidence: 0.99 }),
    mkItem({ title: 'yes', belongs_to_user: 'yes', confidence: 0.6 })
  ])?.title === 'yes'
)
check('最优低于阈值返回 null', pickBest([mkItem({ confidence: SUGGEST_MIN_CONFIDENCE - 0.1 })]) === null)
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd al1 && npm run test:screen`
Expected: FAIL —— 报找不到 `../src/shared/suggest.ts`。

- [ ] **Step 3: 实现** — 创建 `src/shared/suggest.ts`

```ts
import type { ParsedItem } from './parsing'

/** 低于此置信度不出建议（宁漏勿误，对齐 Apple HIG） */
export const SUGGEST_MIN_CONFIDENCE = 0.4

/** 从解析出的事项里挑最可能作为单条建议的一项；没有合适的返回 null */
export function pickBest(items: ParsedItem[]): ParsedItem | null {
  const candidates = items.filter((i) => i.belongs_to_user !== 'no')
  if (!candidates.length) return null
  const score = (i: ParsedItem): number =>
    (i.belongs_to_user === 'yes' ? 2 : i.belongs_to_user === 'uncertain' ? 1 : 0) * 1000 +
    i.confidence * 100 +
    (i.start_time || i.due_time ? 1 : 0)
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a))
  return best.confidence >= SUGGEST_MIN_CONFIDENCE ? best : null
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd al1 && npm run test:screen`
Expected: PASS —— "全部通过"。

- [ ] **Step 5: 提交**

```bash
cd al1 && git add src/shared/suggest.ts test/screen-smoke.mjs
git commit -m "feat(screen): pickBest 选最优纯函数"
```

---

## Task 3: 类型与设置层（types + labels + db）

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/src/labels.ts:44-52`
- Modify: `src/main/db.ts`

- [ ] **Step 1: types.ts —— 扩展 SourceType / AppSettings，新增 ScanResult**

`src/shared/types.ts:1-8` 的 `SourceType` 联合类型末尾加 `screen_scan`：

```ts
export type SourceType =
  | 'clipboard_text'
  | 'clipboard_image'
  | 'clipboard_file'
  | 'screenshot'
  | 'file'
  | 'text_input'
  | 'feishu'
  | 'screen_scan'
```

`AppSettings`（`src/shared/types.ts:101-109`）在 `feishuAppSecret` 后加三字段：

```ts
export interface AppSettings {
  /** Electron accelerator 字符串，如 "Alt+C"、"Command+Shift+K" */
  hotkey: string
  apiBase: string
  apiKey: string
  model: string
  feishuAppId: string
  feishuAppSecret: string
  /** 屏幕感知建议：opt-in 开关，默认 false */
  screenSenseEnabled: boolean
  /** 触发解析的关键词 */
  screenSenseKeywords: string[]
  /** 扫描屏幕的全局快捷键 accelerator */
  screenSenseHotkey: string
}
```

在文件末尾 `FeishuStatus` 之后追加：

```ts
export interface ScanResult {
  status: 'suggested' | 'empty' | 'error'
  message: string
}
```

- [ ] **Step 2: labels.ts —— SOURCE_LABELS 补 screen_scan**

`src/renderer/src/labels.ts:44-52` 的 `SOURCE_LABELS` 末项 `feishu` 后加：

```ts
export const SOURCE_LABELS: Record<SourceType, string> = {
  clipboard_text: '剪切板文本',
  clipboard_image: '剪切板图片',
  clipboard_file: '剪切板文件',
  screenshot: '截图',
  file: '文件',
  text_input: '手动输入',
  feishu: '飞书消息',
  screen_scan: '屏幕识别'
}
```

- [ ] **Step 3: db.ts —— getSettings/saveSettings 读写三字段**

`src/main/db.ts:6` 在 `import { localNow } from '@shared/parsing'` 后加：

```ts
import { DEFAULT_SCREEN_KEYWORDS } from '@shared/keywords'
```

`getSettings`（`src/main/db.ts:85-104`）的 return 对象里，`feishuAppSecret` 行后追加三字段：

```ts
  return {
    hotkey: map.hotkey || legacy[map.hotkeyMode] || 'Alt+C',
    // ?? 而不是 ||：用户显式清空后不能从 .env 静默复活
    apiBase: map.apiBase ?? env.AL1_API_BASE ?? '',
    apiKey: map.apiKey ?? env.AL1_API_KEY ?? '',
    model: map.model || env.AL1_MODEL || 'gpt-5.5',
    feishuAppId: map.feishuAppId ?? env.AL1_FEISHU_APP_ID ?? '',
    feishuAppSecret: map.feishuAppSecret ?? env.AL1_FEISHU_APP_SECRET ?? '',
    screenSenseEnabled: map.screenSenseEnabled === 'true',
    screenSenseKeywords: parseKeywords(map.screenSenseKeywords),
    screenSenseHotkey: map.screenSenseHotkey || 'Alt+S'
  }
```

`saveSettings` 上方（`src/main/db.ts:106` 之前）新增 helper：

```ts
/** 逗号存储的关键词字符串 → 数组；空则用默认词表 */
function parseKeywords(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list.length ? list : DEFAULT_SCREEN_KEYWORDS
}
```

`saveSettings`（`src/main/db.ts:106-113`）无需改动：现有 `String(v)` 对 `boolean` 得 `'true'/'false'`、对 `string[]` 得逗号拼接，正好与 `parseKeywords` / `=== 'true'` 对应。

- [ ] **Step 4: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS（无 TS 报错）。注意 `keywords.ts` 已在 Task 1 创建，import 可解析。

- [ ] **Step 5: 提交**

```bash
cd al1 && git add src/shared/types.ts src/renderer/src/labels.ts src/main/db.ts
git commit -m "feat(screen): 设置层接入 screenSense 字段与 screen_scan 来源类型"
```

---

## Task 4: 静默截图 + 解析提示词（capture.ts）

**Files:**
- Modify: `src/main/capture.ts:148-156`（HINTS 导出 + 新增 screen_scan）
- Modify: `src/main/capture.ts`（新增 `captureScreenSilently`）

- [ ] **Step 1: HINTS 导出并新增 screen_scan**

`src/main/capture.ts:148` 把 `const HINTS` 改为 `export const HINTS`，并在 `feishu` 项后加 `screen_scan`：

```ts
export const HINTS: Record<string, string> = {
  clipboard_text: '以下是用户从剪切板提交的文本（通常来自聊天、通知或邮件），请提取其中的行动项。',
  clipboard_image: '用户从剪切板提交了一张图片（通常是聊天或通知截图），请识别图中文字并提取行动项。',
  clipboard_file: '以下是用户提交的文件内容，请提取其中的行动项。',
  screenshot: '用户提交了一张屏幕截图（通常是聊天、群通知、网页或课程平台），请识别图中文字并提取行动项。',
  file: '以下是用户拖拽提交的文件内容，请提取其中的行动项。',
  text_input: '以下是用户粘贴/输入的文本，请提取其中的行动项。',
  feishu: '以下是用户从飞书转发给 al1 机器人的消息（通常是群通知、聊天记录或截图），请提取其中的行动项。',
  screen_scan:
    '以下是从用户屏幕上 OCR 识别出的文字，可能混有菜单、按钮、侧边栏等无关界面文字。请只提取明确的、与用户本人相关的行动项；信息不足或无法确认时不要硬凑，宁可一个都不提取。'
}
```

- [ ] **Step 2: 新增 captureScreenSilently**

在 `src/main/capture.ts` 的 `takeScreenshot`（`:113-122`）函数之后追加：

```ts
/** 静默全屏截图（无交互、无快门声），返回临时 png 路径；失败返回 null。调用方 OCR 后须自行删除 */
export async function captureScreenSilently(): Promise<string | null> {
  const file = join(app.getPath('temp'), `al1-screen-${Date.now()}.png`)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('screencapture', ['-x', file], (err) => (err ? reject(err) : resolve()))
    })
  } catch {
    return null
  }
  return existsSync(file) ? file : null
}
```

（`execFile` / `existsSync` / `join` / `app` 均已在 `capture.ts` 顶部导入，无需新增 import。）

- [ ] **Step 3: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
cd al1 && git add src/main/capture.ts
git commit -m "feat(screen): 静默全屏截图 + screen_scan 解析提示词"
```

---

## Task 5: 本地 OCR 模块（ocr.ts）

**Files:**
- Create: `src/main/ocr.ts`

- [ ] **Step 1: 实现 ocr.ts（内嵌 Swift + swiftc 编译缓存 + ocrImage）**

```ts
import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

// 仿 quickaction.ts 的内嵌脚本模式：Swift 源码内嵌，首次用时编译缓存
const SWIFT_SRC = `import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
  FileHandle.standardError.write("usage: vision-ocr <image>\\n".data(using: .utf8)!)
  exit(2)
}
guard let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load image\\n".data(using: .utf8)!)
  exit(3)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
  let lines = (request.results ?? []).compactMap {
    ($0 as? VNRecognizedTextObservation)?.topCandidates(1).first?.string
  }
  print(lines.joined(separator: "\\n"))
} catch {
  FileHandle.standardError.write("ocr failed: \\(error)\\n".data(using: .utf8)!)
  exit(4)
}
`

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

let ensured: Promise<string> | null = null

/** 返回编译好的 vision-ocr 路径；不存在则用 swiftc 现编译并缓存 */
async function ensureOcrBinary(): Promise<string> {
  const bin = join(binDir(), 'vision-ocr')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'vision-ocr.swift')
  writeFileSync(src, SWIFT_SRC)
  try {
    await execFileAsync('swiftc', ['-O', '-o', bin, src])
  } catch {
    throw new Error('本地 OCR 初始化失败：需要 Xcode 命令行工具（请运行 xcode-select --install）')
  }
  return bin
}

/** 对 png 做本地 Apple Vision OCR，返回逐行拼接的文字 */
export async function ocrImage(pngPath: string): Promise<string> {
  // 编译失败时重置，下次重试；成功后缓存 Promise 避免重复编译
  if (!ensured)
    ensured = ensureOcrBinary().catch((e) => {
      ensured = null
      throw e
    })
  const bin = await ensured
  const { stdout } = await execFileAsync(bin, [pngPath], { maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}
```

- [ ] **Step 2: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 3: 验证编译可行（开发机）** —— 单独验证 Swift 能编译并识别中文

```bash
cd al1 && mkdir -p /tmp/al1-ocr-test && node -e "
const { writeFileSync } = require('fs');
// 这一步只验证 swiftc 在本机可用；真实编译在 app 内首次扫描时进行
const { execFileSync } = require('child_process');
try { execFileSync('swiftc', ['--version'], { stdio: 'inherit' }); console.log('swiftc OK'); }
catch (e) { console.error('swiftc 不可用，需 xcode-select --install'); process.exit(1); }
"
```

Expected: 打印 swiftc 版本 + "swiftc OK"。若失败，说明本机缺 Xcode 命令行工具——这是运行前置条件，不是代码 bug。

- [ ] **Step 4: 提交**

```bash
cd al1 && git add src/main/ocr.ts
git commit -m "feat(screen): 本地 Apple Vision OCR（内嵌 Swift + swiftc 编译缓存）"
```

---

## Task 6: 扫描编排（screenwatch.ts）

**Files:**
- Create: `src/main/screenwatch.ts`

- [ ] **Step 1: 实现 screenwatch.ts**

```ts
import { unlink } from 'fs/promises'
import { captureScreenSilently, HINTS } from './capture'
import { ocrImage } from './ocr'
import { parseToItems } from './parser'
import { createSource, createTask, deleteSourceRow, getSettings, taskExists } from './db'
import { broadcast, showPreview } from './windows'
import { initScanHotkey, unregisterScanHotkey } from './hotkey'
import { matchKeywords } from '@shared/keywords'
import { pickBest } from '@shared/suggest'
import type { AddedInfo, ParsedItem } from '@shared/parsing'
import type { ParseSummary, ScanResult, TaskStatus } from '@shared/types'

function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function emptySummary(error: string | null): ParseSummary {
  return { sourceId: '', total: 0, related: 0, autoAdded: 0, duplicates: 0, error }
}

/** 扫描一次当前屏幕：截图 → 本地 OCR → 解析 → 选最优 → 右下角弹建议卡 */
export async function scanOnce(): Promise<ScanResult> {
  try {
    const png = await captureScreenSilently()
    if (!png) return { status: 'error', message: '截图失败，请检查屏幕录制权限' }

    let text: string
    try {
      text = await ocrImage(png)
    } finally {
      void unlink(png).catch(() => {}) // 截图用完即弃
    }
    if (!text) return { status: 'empty', message: '屏幕上没有识别到文字' }

    const { screenSenseKeywords } = getSettings()
    const hits = matchKeywords(text, screenSenseKeywords)

    const items = await parseToItems({ text, hint: HINTS.screen_scan })
    const best = pickBest(items)
    if (!best) {
      showPreview({ summary: emptySummary(null) }) // 复用 PreviewCard 的"未发现相关事项"形态，3s 自动消失
      return { status: 'empty', message: '未发现明确的待办事项' }
    }

    showPreview({ suggestion: { item: best, sourceText: text, hits } })
    return { status: 'suggested', message: `发现一条可能的待办：${best.title}` }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    showPreview({ summary: emptySummary(message) })
    return { status: 'error', message }
  }
}

/** 建议卡点"同意/修改"时入库：来源存 OCR 文字（非图），任务直接进日程 */
export function acceptSuggestion(payload: { item: ParsedItem; sourceText: string }): AddedInfo {
  const { item, sourceText } = payload
  const source = createSource({
    type: 'screen_scan',
    excerpt: excerptOf(sourceText),
    content: sourceText.slice(0, 20000),
    filePath: null
  })
  const time = item.due_time ?? item.start_time
  if (taskExists(item.title, item.due_time)) {
    deleteSourceRow(source.id) // 没有任务引用的来源不留库
    return { candidate: 0, title: item.title, time, duplicate: true, item }
  }
  const status: TaskStatus = item.due_time || item.start_time ? 'scheduled' : 'not_started'
  createTask({
    sourceId: source.id,
    title: item.title,
    itemType: item.item_type,
    belongsToUser: item.belongs_to_user,
    belongingReason: item.belonging_reason,
    userRole: item.user_role,
    startTime: item.start_time,
    dueTime: item.due_time,
    location: item.location,
    priority: item.priority,
    confidence: item.confidence,
    suggestedAction: item.suggested_action,
    evidence: item.evidence,
    notes: item.notes,
    duplicateOf: item.duplicate_of,
    status,
    feedback: null
  })
  broadcast('al1:tasks-updated')
  return { candidate: 0, title: item.title, time, duplicate: false }
}

/** 跟随设置开关注册/注销扫描快捷键（启动时 + settings:save 时调用） */
export function applyScreenSenseSettings(): void {
  const { screenSenseEnabled, screenSenseHotkey } = getSettings()
  if (screenSenseEnabled) initScanHotkey(screenSenseHotkey, () => void scanOnce())
  else unregisterScanHotkey()
}

// ---- Phase 2 预留：后台常驻监控 ----
export function startWatch(): void {}
export function stopWatch(): void {}
```

- [ ] **Step 2: 类型检查（预期此处会因 hotkey 函数未定义而失败）**

Run: `cd al1 && npm run typecheck`
Expected: FAIL —— 报 `initScanHotkey` / `unregisterScanHotkey` 在 `./hotkey` 中不存在。Task 7 补上后即通过。先不提交，进入 Task 7。

---

## Task 7: 扫描快捷键（hotkey.ts 具名注册表）

**Files:**
- Modify: `src/main/hotkey.ts`（整文件重写为具名注册表，保留原有 setHotkey/initHotkey/stopHotkey 签名）

- [ ] **Step 1: 重写 hotkey.ts** —— 用整文件内容替换

```ts
import { globalShortcut } from 'electron'

const DEBOUNCE_MS = 800

interface Entry {
  accelerator: string | null
  handler: () => void
  last: number
}

const entries = new Map<string, Entry>()

function entryOf(id: string): Entry {
  let e = entries.get(id)
  if (!e) {
    e = { accelerator: null, handler: () => {}, last: 0 }
    entries.set(id, e)
  }
  return e
}

function fireOf(id: string): () => void {
  return () => {
    const e = entries.get(id)
    if (!e) return
    const now = Date.now()
    if (now - e.last < DEBOUNCE_MS) return
    e.last = now
    e.handler()
  }
}

/** 注册/更新具名快捷键；失败时恢复旧键并返回 false（组合无效或被占用） */
function register(id: string, accelerator: string): boolean {
  const e = entryOf(id)
  const prev = e.accelerator
  if (prev) globalShortcut.unregister(prev)
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, fireOf(id))
  } catch {
    ok = false
  }
  if (ok) e.accelerator = accelerator
  else if (prev) globalShortcut.register(prev, fireOf(id))
  return ok
}

function unregister(id: string): void {
  const e = entries.get(id)
  if (e?.accelerator) {
    globalShortcut.unregister(e.accelerator)
    e.accelerator = null
  }
}

// ---- 剪切板捕获快捷键（原有公开 API，签名不变） ----

export function setHotkey(accelerator: string): boolean {
  return register('clipboard', accelerator)
}

export function initHotkey(initial: string, trigger: () => void): void {
  entryOf('clipboard').handler = trigger
  if (!register('clipboard', initial)) {
    console.warn(`[hotkey] ${initial} 注册失败，可能被其他应用占用`)
  }
}

export function stopHotkey(): void {
  globalShortcut.unregisterAll()
}

// ---- 扫描屏幕快捷键 ----

export function initScanHotkey(accelerator: string, trigger: () => void): boolean {
  entryOf('scan').handler = trigger
  const ok = register('scan', accelerator)
  if (!ok) console.warn(`[hotkey] 扫描快捷键 ${accelerator} 注册失败，可能被其他应用占用`)
  return ok
}

export function unregisterScanHotkey(): void {
  unregister('scan')
}
```

- [ ] **Step 2: 类型检查（screenwatch + hotkey 一起通过）**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 3: 提交（screenwatch + hotkey 一起）**

```bash
cd al1 && git add src/main/screenwatch.ts src/main/hotkey.ts
git commit -m "feat(screen): 扫描编排 screenwatch + 具名快捷键注册表"
```

---

## Task 8: IPC 接线（ipc.ts）

**Files:**
- Modify: `src/main/ipc.ts`

- [ ] **Step 1: 增加 import**

`src/main/ipc.ts:27`（`import { ensureFeishu, feishuStatus } from './feishu'`）之后加：

```ts
import { acceptSuggestion, applyScreenSenseSettings, scanOnce } from './screenwatch'
```

- [ ] **Step 2: settings:save 中触发 applyScreenSenseSettings**

`src/main/ipc.ts:59`（`if (patch.feishuAppId !== undefined ...) ensureFeishu()`）之后加一行：

```ts
    if (patch.screenSenseEnabled !== undefined || patch.screenSenseHotkey !== undefined)
      applyScreenSenseSettings()
```

- [ ] **Step 3: 注册两个新 handler**

`src/main/ipc.ts:116`（`ipcMain.handle('feishu:status', () => feishuStatus())`）之后加：

```ts
  ipcMain.handle('screen:scan', () => scanOnce())
  ipcMain.handle('suggestion:accept', (_e, payload: { item: ParsedItem; sourceText: string }) =>
    acceptSuggestion(payload)
  )
```

（`ParsedItem` 已在 `src/main/ipc.ts:24` 从 `@shared/parsing` 导入。）

- [ ] **Step 4: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd al1 && git add src/main/ipc.ts
git commit -m "feat(screen): IPC 接入 screen:scan / suggestion:accept"
```

---

## Task 9: 启动时注册扫描快捷键（index.ts）

**Files:**
- Modify: `src/main/index.ts:6-8`（import）、`src/main/index.ts:41-49`（whenReady）

- [ ] **Step 1: 增加 import**

`src/main/index.ts:6`（`import { ensureFeishu } from './feishu'`）之后加：

```ts
import { applyScreenSenseSettings } from './screenwatch'
```

- [ ] **Step 2: whenReady 末尾调用**

`src/main/index.ts:48`（`ensureFeishu()`）之后、`})` 之前加一行：

```ts
    applyScreenSenseSettings()
```

最终该块形如：

```ts
  app.whenReady().then(() => {
    initDb()
    registerIpc()
    createMainWindow()
    createTray()
    initHotkey(getSettings().hotkey, triggerClipboardCapture)
    initDropbox()
    ensureFeishu()
    applyScreenSenseSettings()
  })
```

- [ ] **Step 3: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
cd al1 && git add src/main/index.ts
git commit -m "feat(screen): 启动时按设置注册扫描快捷键"
```

---

## Task 10: 渲染层 API（api.ts）

**Files:**
- Modify: `src/renderer/src/api.ts`

- [ ] **Step 1: 扩展 import 类型**

`src/renderer/src/api.ts:1-11` 的 `@shared/types` 导入里加入 `ScanResult`：

```ts
import type {
  AppSettings,
  FeishuStatus,
  ParseSummary,
  PendingCapture,
  PermissionStatus,
  Profile,
  ScanResult,
  SourceRecord,
  TaskRecord,
  TaskStatus
} from '@shared/types'
```

- [ ] **Step 2: 增加两个方法**

`src/renderer/src/api.ts:51`（`feishuStatus: () => inv<FeishuStatus>('feishu:status'),`）之后加：

```ts
  screenScan: () => inv<ScanResult>('screen:scan'),
  suggestionAccept: (payload: { item: ParsedItem; sourceText: string }) =>
    inv<AddedInfo>('suggestion:accept', payload),
```

（`ParsedItem` 与 `AddedInfo` 已在 `src/renderer/src/api.ts:12-18` 从 `@shared/parsing` 导入。）

- [ ] **Step 3: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
cd al1 && git add src/renderer/src/api.ts
git commit -m "feat(screen): 渲染层 api 增加 screenScan / suggestionAccept"
```

---

## Task 11: 建议卡（PreviewCard.tsx 新增 suggestion / done phase）

**Files:**
- Modify: `src/renderer/src/pages/PreviewCard.tsx`

- [ ] **Step 1: 扩展 import 与 State**

`src/renderer/src/pages/PreviewCard.tsx:2` 改为同时导入 ParsedItem：

```tsx
import type { ParseSummary, PendingCapture } from '@shared/types'
import type { ParsedItem } from '@shared/parsing'
```

`State` 联合类型（`:6-12`）追加两种形态：

```tsx
type State =
  | { phase: 'idle' }
  | { phase: 'preview'; capture: PendingCapture; left: number }
  | { phase: 'loading'; message?: string }
  | { phase: 'result'; summary: ParseSummary }
  | { phase: 'error'; message: string }
  | { phase: 'empty'; message: string }
  | { phase: 'suggestion'; item: ParsedItem; sourceText: string; hits: string[] }
  | { phase: 'done'; message: string }
```

- [ ] **Step 2: 在 al1:preview 监听里识别 suggestion 形态**

`src/renderer/src/pages/PreviewCard.tsx:48-72` 的 `api.on('al1:preview', (payload) => {...})` 回调中，把 payload 类型联合补一种，并在 `if (p.busy)` 分支之前加 suggestion 分支。将回调体改为：

```tsx
    return api.on('al1:preview', (payload) => {
      const p = payload as
        | (PendingCapture & { error?: undefined; busy?: undefined; summary?: undefined; suggestion?: undefined })
        | { error: string; busy?: undefined; summary?: undefined; suggestion?: undefined }
        | { busy: string; error?: undefined; summary?: undefined; suggestion?: undefined }
        | { summary: ParseSummary; error?: undefined; busy?: undefined; suggestion?: undefined }
        | { suggestion: { item: ParsedItem; sourceText: string; hits: string[] }; error?: undefined; busy?: undefined; summary?: undefined }
      submitIdRef.current = ''
      if ('suggestion' in p && p.suggestion) {
        setState({ phase: 'suggestion', ...p.suggestion })
      } else if (p.busy) {
        setState({ phase: 'loading', message: p.busy })
      } else if (p.summary) {
        if (p.summary.error) setState({ phase: 'error', message: p.summary.error })
        else setState({ phase: 'result', summary: p.summary })
      } else if ('error' in p && p.error) {
        setState({ phase: 'empty', message: p.error })
      } else {
        const capture = p as PendingCapture
        setState({
          phase: 'preview',
          capture,
          left: capture.sensitiveHits.length || capture.kind !== 'text' ? -1 : AUTO_SECONDS
        })
      }
    })
```

- [ ] **Step 3: 给 done phase 加自动关闭**

`src/renderer/src/pages/PreviewCard.tsx:75-92` 的第二个 `useEffect` 里，把 empty 的自动关闭分支扩展为同时覆盖 done：

```tsx
    if (
      state.phase === 'empty' ||
      state.phase === 'done' ||
      (state.phase === 'result' && state.summary.related === 0)
    ) {
      const t = window.setTimeout(close, state.phase === 'done' ? 1800 : 3000)
      return () => window.clearTimeout(t)
    }
```

- [ ] **Step 4: 增加 accept 处理函数**

在 `close`（`:42-45`）之后加：

```tsx
  const acceptSuggestion = async (modify: boolean): Promise<void> => {
    if (state.phase !== 'suggestion') return
    const { item, sourceText } = state
    setState({ phase: 'loading', message: '正在加入…' })
    try {
      const info = await api.suggestionAccept({ item, sourceText })
      if (modify) {
        void api.focusMain('schedule')
        setState({ phase: 'idle' })
      } else if (info.duplicate) {
        setState({ phase: 'done', message: `「${info.title}」与已有任务相同，未重复添加` })
      } else {
        setState({ phase: 'done', message: `✓ 已加入「${info.title}」` })
      }
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
```

- [ ] **Step 5: 渲染 suggestion / done 两个形态**

在 `{state.phase === 'empty' && ...}`（`:237`）那一行之后、最外层 `</div>` 之前，加入：

```tsx
        {state.phase === 'suggestion' && (
          <>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                屏幕识别
              </span>
              <span className="min-w-0 flex-1 text-sm leading-5 font-medium">{state.item.title}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-xs text-slate-500">
              {state.item.start_time && <span>开始：{state.item.start_time.replace('T', ' ')}</span>}
              {state.item.due_time && (
                <span className="text-red-500">截止：{state.item.due_time.replace('T', ' ')}</span>
              )}
              {state.item.location && <span>地点：{state.item.location}</span>}
            </div>
            {state.item.belonging_reason && (
              <div className="text-xs text-slate-400">{state.item.belonging_reason}</div>
            )}
            {state.hits.length > 0 && (
              <div className="text-[11px] text-slate-400">命中：{state.hits.join('、')}</div>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                onClick={() => {
                  void api.previewHide()
                  setState({ phase: 'idle' })
                }}
              >
                拒绝
              </button>
              <button
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                onClick={() => void acceptSuggestion(true)}
              >
                修改
              </button>
              <button
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700"
                onClick={() => void acceptSuggestion(false)}
              >
                同意
              </button>
            </div>
          </>
        )}

        {state.phase === 'done' && (
          <div className="py-1 text-xs text-emerald-600">{state.message}</div>
        )}
```

- [ ] **Step 6: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
cd al1 && git add src/renderer/src/pages/PreviewCard.tsx
git commit -m "feat(screen): 建议卡（同意/拒绝/修改）+ 入库确认形态"
```

---

## Task 12: 助手页"扫描屏幕"按钮（Assistant.tsx）

**Files:**
- Modify: `src/renderer/src/pages/Assistant.tsx`

- [ ] **Step 1: 增加 screenSense 状态与扫描函数**

`src/renderer/src/pages/Assistant.tsx:50-58`，在 `const [sourceId, setSourceId] = useState<string | null>(null)` 之后加：

```tsx
  const [screenSense, setScreenSense] = useState(false)
```

在已有的首个 `useEffect`（`:66-68` 处的 scrollIntoView effect）之后，新增一个 effect 读取并订阅设置：

```tsx
  useEffect(() => {
    const load = (): void => {
      void api.getSettings().then((s) => setScreenSense(s.screenSenseEnabled))
    }
    load()
    return api.on('al1:settings-updated', load)
  }, [])
```

在 `screenshot`（`:178-189`）函数之后加：

```tsx
  const scanScreen = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.screenScan()
      showToast(r.message)
    } catch (e) {
      showToast(`扫描失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
```

- [ ] **Step 2: 在输入栏加按钮（仅开启时显示）**

`src/renderer/src/pages/Assistant.tsx:415-422`，在"截图"按钮之前插入：

```tsx
          {screenSense && (
            <button
              title="扫描当前屏幕，自动提取待办"
              disabled={busy}
              onClick={() => void scanScreen()}
              className="rounded-lg border border-indigo-300 px-2.5 py-2 text-xs text-indigo-600 hover:bg-indigo-50 disabled:opacity-40"
            >
              扫描屏幕
            </button>
          )}
```

- [ ] **Step 3: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
cd al1 && git add src/renderer/src/pages/Assistant.tsx
git commit -m "feat(screen): 助手页扫描屏幕按钮（开启时显示）"
```

---

## Task 13: 设置页"屏幕感知建议"区（Settings.tsx）

**Files:**
- Modify: `src/renderer/src/pages/Settings.tsx`

- [ ] **Step 1: 增加 scan 快捷键录制状态**

`src/renderer/src/pages/Settings.tsx:78`（`const [recording, setRecording] = useState(false)`）之后加：

```tsx
  const [scanRecording, setScanRecording] = useState(false)
```

- [ ] **Step 2: 增加 scan 快捷键录制 effect 与 apply 函数**

在已有 `applyHotkey`（`:105-113`）之后加：

```tsx
  const applyScanHotkey = async (acc: string): Promise<void> => {
    await api.saveSettings({ screenSenseHotkey: acc })
    setSettings((s) => (s ? { ...s, screenSenseHotkey: acc } : s))
    flash(`扫描快捷键已设为 ${formatHotkey(acc)}`)
  }
```

在已有的录制 `useEffect`（`:115-131`）之后加一个并行的 scan 录制 effect：

```tsx
  useEffect(() => {
    if (!scanRecording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setScanRecording(false)
        return
      }
      const acc = eventToAccelerator(e)
      if (!acc) return
      setScanRecording(false)
      void applyScanHotkey(acc)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [scanRecording])
```

- [ ] **Step 3: 加入设置区 UI**

`src/renderer/src/pages/Settings.tsx`，在"飞书机器人" Section（以 `<Section title="飞书机器人">` 开头、到对应 `</Section>` 结束，约 `:334-400`）之后插入新 Section：

```tsx
      <Section title="屏幕感知建议（隐私功能）">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          开启后可手动「扫描当前屏幕」：al1 在本机识别屏幕上的文字，命中关键词时把文字（非截图）送解析，
          给出一条待办建议供你确认。截图用完即弃、不保存、不上传。注意：macOS 会在你扫描时显示系统录制指示器，
          这是系统强制行为、无法关闭。首次使用会自动编译本地 OCR 组件（需 Xcode 命令行工具）。
        </p>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>启用屏幕感知建议</span>
          <input
            type="checkbox"
            checked={settings.screenSenseEnabled}
            onChange={async (e) => {
              const next = e.target.checked
              setSettings({ ...settings, screenSenseEnabled: next })
              await api.saveSettings({ screenSenseEnabled: next })
              flash(next ? '已开启屏幕感知建议' : '已关闭屏幕感知建议')
            }}
          />
        </label>

        {settings.screenSenseEnabled && (
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-slate-500">触发关键词（逗号或顿号分隔）</span>
              <input
                className={input}
                defaultValue={settings.screenSenseKeywords.join('、')}
                onBlur={async (e) => {
                  const list = splitList(e.target.value)
                  setSettings({ ...settings, screenSenseKeywords: list })
                  await api.saveSettings({ screenSenseKeywords: list })
                  flash('关键词已保存')
                }}
              />
            </label>

            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-500">扫描快捷键</span>
              <button
                onClick={() => setScanRecording(!scanRecording)}
                className={`min-w-44 rounded-lg border px-4 py-2 font-medium ${
                  scanRecording
                    ? 'animate-pulse border-indigo-400 bg-indigo-50 text-indigo-600'
                    : 'border-slate-300 hover:border-slate-400'
                }`}
              >
                {scanRecording ? '按下新组合键…' : formatHotkey(settings.screenSenseHotkey)}
              </button>
              {scanRecording && <span className="text-xs text-slate-400">Esc 取消</span>}
            </div>

            {perms && perms.screen !== 'granted' && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                屏幕录制权限未授权，扫描会失败。请到 系统设置 → 隐私与安全性 → 屏幕录制 中允许 al1。
              </div>
            )}
          </div>
        )}
      </Section>
```

（`splitList` / `formatHotkey` / `eventToAccelerator` / `input` / `Section` / `perms` 均已在本文件作用域内，无需新增 import。）

- [ ] **Step 4: 类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd al1 && git add src/renderer/src/pages/Settings.tsx
git commit -m "feat(screen): 设置页屏幕感知建议区（开关+关键词+扫描快捷键+权限引导）"
```

---

## Task 14: 全量验证

- [ ] **Step 1: 纯函数测试**

Run: `cd al1 && npm run test:screen`
Expected: PASS —— "全部通过"。

- [ ] **Step 2: 全量类型检查**

Run: `cd al1 && npm run typecheck`
Expected: PASS（main + web 两个 tsconfig 都过）。

- [ ] **Step 3: 构建**

Run: `cd al1 && npm run build`
Expected: 构建成功，无报错。

- [ ] **Step 4: 手动验证（开发机，需屏幕录制权限 + .env 配好 API）**

Run: `cd al1 && npm run dev`

逐项确认：
1. 设置页出现"屏幕感知建议"区，默认**关闭**；助手页**无**"扫描屏幕"按钮。
2. 打开开关 → 助手页出现"扫描屏幕"按钮；设置页出现关键词框 + 扫描快捷键。
3. 屏幕上打开一条含"会议/考试/截止"的通知文本 → 点"扫描屏幕"（或按快捷键）→ 首次会编译 OCR（稍等几秒）→ 右下角弹出建议卡，含标题/时间/命中词。
4. 点**同意** → 卡显示"✓ 已加入「…」"后自动消失 → 日程页出现该任务。
5. 再扫一次点**拒绝** → 卡消失，日程**不**新增。
6. 再扫一次点**修改** → 任务入库 + 跳到日程页。
7. 对着一屏无关内容扫描 → 弹"未发现相关事项"卡，3 秒自动消失。
8. 关闭开关 → 扫描快捷键失效、助手页按钮消失。

- [ ] **Step 5: 完成分支收尾**

REQUIRED SUB-SKILL: 用 superpowers:finishing-a-development-branch 决定合并 / PR / 清理。

---

## Self-Review（写计划后自查）

**Spec 覆盖：**
- 本地 OCR 只送文字 → Task 5（ocr）+ Task 6（scanOnce 只传 text）✓
- 手动扫描最小闭环 → Task 6 + Task 12（按钮）+ Task 9（快捷键）✓
- 截图即时丢弃 → Task 6 `unlink` in finally ✓
- 关键词匹配独立模块 → Task 1 ✓
- pickBest 在 shared 可测 → Task 2 ✓
- 建议卡 同意/拒绝/修改 → Task 11 ✓
- 设置 opt-in + 关键词 + 快捷键 + 权限引导 → Task 13 ✓
- screen_scan 来源存文字非图 → Task 6 acceptSuggestion ✓
- DB 无 migration → Task 3（仅新增 settings key + SourceType 字符串值）✓
- Phase 2 预留 → Task 6 startWatch/stopWatch 空壳 ✓

**占位符扫描：** 无 TBD/TODO；每个改代码的 step 都给了完整代码。

**类型一致性：** `ScanResult`（types.ts，Task 3）被 screenwatch（Task 6）/ api（Task 10）引用一致；`acceptSuggestion` 入参 `{ item, sourceText }` 在 screenwatch（Task 6）/ ipc（Task 8）/ api（Task 10）/ PreviewCard（Task 11）一致；`initScanHotkey/unregisterScanHotkey`（Task 7）与 screenwatch（Task 6）引用一致；`HINTS` 导出（Task 4）被 screenwatch（Task 6）引用；`parseKeywords`/`DEFAULT_SCREEN_KEYWORDS` 在 db（Task 3）与 keywords（Task 1）一致。

**已知顺序依赖：** Task 6 的 typecheck 故意失败（依赖 Task 7 的 hotkey 函数），两者合并提交——已在 Task 6 Step 2 / Task 7 标注。
