# 屏幕感知建议（Screen-aware Suggestions）设计

状态：已确认设计，待拆实现计划
日期：2026-06-13
作者：al1 + Claude

## 1. 背景与目标

al1 现有的捕获都需要用户主动动作：复制后按快捷键、拖文件、转发飞书、点截图。
本功能提供一个**默认关闭的隐私选项**：用户授权后，al1 帮忙"看一眼屏幕"，在**本机**识别文字，命中
关键词（会议 / 日程 / 考试 / 截止 等）时把识别出的**文字**送解析，给出**一条最可能的待办建议**，
用户在右下角点 **同意 / 拒绝 / 修改** 即可。截图**用完即弃**，不离开本机、不落盘。

### 产品定位（由硬约束决定）

macOS 上做不到真正"无感无痕"：只要用屏幕录制权限截屏，系统强制显示录制指示器（菜单栏橙/紫点、
锁屏"屏幕正被观察"），官方无法关闭，macOS 15 起还会周期性重新提醒授权。因此本功能定位为
**用户知情、默认关闭、可随时暂停**的隐私功能，而非偷偷监控——这与"提供一个隐私选项"的诉求一致。

### 本次范围（Phase 1：手动最小闭环）

- 手动触发一次"扫描当前屏幕"（设置中开启后，提供快捷键 + 托盘菜单 + 助手页按钮）
- 静默全屏截图 → 本地 Apple Vision OCR → 关键词匹配 → 只把文字送现有解析链路 → 取最优一条 →
  右下角建议卡（同意 / 拒绝 / 修改）→ 入库
- 截图即时丢弃，不存原图
- 设置页新增"屏幕感知建议"区：opt-in 开关（默认关）+ 关键词编辑 + 扫描快捷键
- 关键词匹配写成独立纯函数模块（手动模式下不强制门控，但代码就位，供 Phase 2 复用）

### 非本次范围（Phase 2，仅预留接口）

- 后台常驻：`setInterval` 定时快照 + 相邻帧 OCR 文字哈希去重 + 命中冷却去抖
- 前台应用排除名单（需前台应用检测）
- 托盘暂停开关

## 2. 关键决策（已拍板）

| 决策 | 选择 | 理由 |
|---|---|---|
| 截图处理 | **本地 OCR 门控，只送文字** | 截图永不离开本机，最省钱最隐私；复用现有 `parseToItems({text})` |
| 实现范围 | **先做手动「扫描屏幕」最小闭环** | 风险最小、最快验证 OCR 精度与建议质量；常驻留 Phase 2 |
| 原始截图 | **即时丢弃，不存原图** | 对齐 Highlight/Rewind 的"用即弃"，规避 Recall 明文存图的隐私灾难 |
| OCR 引擎 | **Apple Vision（VNRecognizeTextRequest）** | macOS 11+ 原生支持简繁中文、完全离线、免费 |
| OCR 集成方式 | **内嵌 Swift 源码 + 首次用时 swiftc 编译缓存** | 仿 `quickaction.ts` 内嵌脚本模式；免打包二进制、免构建步骤、免签名（开发期） |

## 3. 数据流

```
用户触发扫描（快捷键 / 托盘 / 助手页按钮，仅在开关开启时可用）
  → screencapture -x <temp.png>            # 静默全屏，无交互无声音
  → ocrImage(temp.png) → 纯文字            # 本地 Apple Vision；用完 unlink png
  → matchKeywords(text)                    # 命中信息（手动模式不强制门控）
  → parseToItems({ text, hint: SCREEN_HINT })   # 只发文字给解析 API，复用现有链路
  → pickBest(items): ParsedItem | null     # belongs_to_user≠no，按置信度选 top1，低于阈值返回 null
  → 有最优项: showSuggestion({ item, sourceText, hits })   # 右下角建议卡
     无最优项: showPreview(empty "未发现明确事项")          # 3 秒自动消失
  → 同意 → 入库(scheduled/not_started)，卡片显示 ✓ 后自动关闭
     拒绝 → 丢弃，关闭
     修改 → 入库后聚焦主窗、打开该任务编辑界面
```

截图变量在 OCR 后立即 `unlinkSync`；不创建任何引用原始图片的记录。

## 4. 组件设计

### 4.1 新增 main 进程模块

**`src/main/ocr.ts`** — 本地 OCR
- `ocrImage(pngPath: string): Promise<string>`：返回识别出的纯文字（按行拼接）。
- `ensureOcrBinary(): Promise<string>`：返回已编译的 `vision-ocr` 二进制路径；
  缓存在 `userData/bin/vision-ocr`，不存在则把内嵌的 Swift 源码写临时文件、`swiftc -O` 编译。
- Swift 源码作为字符串常量内嵌（参考 `quickaction.ts` 的内嵌写法）；
  `VNRecognizeTextRequest`，`recognitionLevel = .accurate`，`recognitionLanguages = ["zh-Hans","zh-Hant","en-US"]`，
  读 argv[1] 图片路径，把识别文本逐行打印到 stdout。
- 失败处理：swiftc 不存在 → 抛出"本地 OCR 初始化失败：请先安装 Xcode 命令行工具（xcode-select --install）"。

**`src/main/screenwatch.ts`** — 编排
- `scanOnce(): Promise<ScanResult>`：截图 → OCR → 匹配 → 解析 → `pickBest` 选最优 → 弹卡；返回轻量状态供 toast。
- `acceptSuggestion(item, ocrText): AddedInfo`：创建 `screen_scan` 来源（content = OCR 文字，**非图片**，截断到 20000 字）+ 入库任务。
- 预留 `startWatch()/stopWatch()` 空壳给 Phase 2，由设置开关驱动（仿 `ensureFeishu()`）。

**`src/shared/suggest.ts`** — 选最优（纯函数，仅依赖 `ParsedItem` 类型，可单测）
- `pickBest(items: ParsedItem[]): ParsedItem | null`：过滤 `belongs_to_user==='no'`，
  排序键 = (`belongs_to_user==='yes'` 优先, `confidence` 降序, 有时间优先)，取 top1；
  最优置信度 < `SUGGEST_MIN_CONFIDENCE`(0.4) 返回 null（宁漏勿误，对齐 Apple HIG）。
- 放在 shared 而非 screenwatch，是因为 screenwatch 依赖 electron 无法被纯 node 测试导入。

**静默截图**：在 `capture.ts` 新增 `captureScreenSilently(): Promise<string|null>`，
用 `screencapture -x <file>`（无 `-i`，整屏静默），返回 png 临时路径。
与现有交互式 `takeScreenshot()` 区分。

### 4.2 新增 shared 模块

**`src/shared/keywords.ts`**
- `DEFAULT_SCREEN_KEYWORDS: string[]`：会议 / 日程 / 考试 / 截止 / deadline / ddl / 报名 / 面试 / 笔试 /
  作业 / 答辩 / 讲座 / 预约 / 缴费 / 提交 / 通知 / 签到 …
- `matchKeywords(text: string, keywords: string[]): string[]`：返回命中的关键词（去重、大小写不敏感）。
- 纯函数，无副作用，可单测。

### 4.3 解析提示词（`src/shared/parsing.ts`）

- `HINTS` 新增 `screen_scan` 项：说明这是"从用户屏幕 OCR 出的文字，可能混有无关界面文字，
  只提取明确的、与用户本人相关的行动项；不确定就不要硬凑"。

### 4.4 建议卡（复用右下角预览窗）

**`src/main/windows.ts`**：`showPreview` 的 payload 增加一种 `suggestion` 形态：
`{ suggestion: { item: ParsedItem; sourceText: string; hits: string[] } }`。

**`src/renderer/src/pages/PreviewCard.tsx`**：新增 `phase: 'suggestion'`
- 展示：类型徽标 + 标题 + 开始/截止时间 + 地点 + 命中关键词 + belonging_reason + 置信度
- 三个按钮：
  - **同意** → `api.suggestionAccept({ item, sourceText })` → 显示"✓ 已加入日程" → 1.5s 后自动关闭
  - **拒绝** → `api.previewHide()` → 关闭（不入库、不留痕）
  - **修改** → `api.suggestionAccept(...)` 入库 → `api.focusMain('schedule')` 跳主窗（用现有 TaskDetailModal/EditTaskModal 编辑）→ 关闭卡
- 与现有 preview/loading/result/error/empty 形态并存。

### 4.5 IPC / preload / api

`src/main/ipc.ts` 新增：
- `screen:scan` → `scanOnce()`
- `suggestion:accept` → `acceptSuggestion(item, sourceText)` → `AddedInfo`

`src/renderer/src/api.ts` 新增对应方法：`screenScan()`、`suggestionAccept(payload)`。
preload 已是通用 `invoke/on` 桥，无需改动。

### 4.6 触发入口

- **快捷键**：扩展 `src/main/hotkey.ts` 支持第二个具名快捷键（扫描），默认 `Alt+S`；
  仅在 `screenSenseEnabled` 时注册。
- **托盘**：`index.ts` 托盘菜单在开启时增加"扫描当前屏幕"。
- **助手页**：`Assistant.tsx` 输入栏增加"扫描屏幕"按钮（仅开启时显示），调用 `api.screenScan()`，
  结果用现有 `showToast` 反馈（弹卡由主进程驱动）。

### 4.7 设置与类型

`src/shared/types.ts` — `AppSettings` 增加：
```ts
screenSenseEnabled: boolean      // opt-in，默认 false
screenSenseKeywords: string[]    // 默认 DEFAULT_SCREEN_KEYWORDS
screenSenseHotkey: string        // 默认 'Alt+S'
```
`SourceType` 增加 `'screen_scan'`；`SOURCE_LABELS` 增加"屏幕识别"。

`src/main/db.ts` `getSettings/saveSettings`：
- enabled 存 `'true'/'false'`，读时 `=== 'true'`
- keywords 逗号拼接存储，读时 `split(',')` 去空；缺省用 `DEFAULT_SCREEN_KEYWORDS`
- hotkey 字符串，缺省 `'Alt+S'`
- **DB schema 不变**（settings 是 KV 表，仅新增 key；SourceType 仅新增字符串值）——无 migration。

`src/renderer/src/pages/Settings.tsx` — 新增"屏幕感知建议"区：
- 开关（默认关，文案说明会用屏幕录制权限、系统会显示录制指示器、截图用完即弃）
- 关键词编辑（逗号/顿号分隔，复用 `splitList`）
- 扫描快捷键（复用现有按键录制逻辑）
- 开启时若屏幕录制权限未授权，给引导提示（复用现有"权限状态"区数据）

## 5. 隐私与安全设计（默认就位，不单独询问）

- **opt-in**：默认关闭，开关在设置页，关闭时所有入口（快捷键/托盘/按钮）都不出现。
- **截图用即弃**：OCR 后立即删除 png；不存原图。
- **只送文字**：发往云端解析 API 的只有 OCR 文字，截图不外发。
- **来源可删**：`screen_scan` 来源存 OCR 文字（非图），用户可用现有 `source:delete` 删除。
- **敏感内容**：复用 `sensitive.ts`；解析提示词已要求凭据不进 title/notes。
- **录制指示器**：无法隐藏，设置文案如实告知。

## 6. 测试

纯函数单测（沿用 `test/parser-smoke.mjs` 的 node 脚本风格，新增 `test/screen-smoke.mjs`）：
- `matchKeywords`：命中/不命中/大小写/去重
- `pickBest`：过滤 belongs_to_user=no、置信度排序、低置信返回 null、空数组返回 null

手动验证（开发机）：
- 屏幕上打开一条含"会议/考试"的通知 → 扫描 → 出现建议卡 → 同意 → 日程出现该任务
- 拒绝不入库；修改跳主窗编辑
- 无相关内容 → "未发现明确事项"卡片自动消失
- OCR 首次触发会编译 Swift（验证 swiftc 可用 / 缺失时报错友好）

## 7. 风险与回滚

- **风险**：录制指示器不可隐藏（产品上接受）；中文 OCR 精度依赖 macOS 版本；
  首次 swiftc 编译需 Xcode 命令行工具；全屏 OCR 文字可能含无关界面噪声（靠 pickBest 阈值 + 解析提示词缓解）。
- **回滚**：纯新增 + 一个默认关的开关；关掉即完全无副作用。不改现有捕获/解析/DB 行为，
  无 schema migration（仅新增 settings key 与一个 SourceType 字符串值），老数据零风险。

## 8. 模块清单

| 文件 | 改动 |
|---|---|
| `src/main/ocr.ts` | 新增：内嵌 Swift + swiftc 编译缓存 + `ocrImage` |
| `src/main/screenwatch.ts` | 新增：`scanOnce` / `acceptSuggestion` / Phase2 空壳 |
| `src/shared/suggest.ts` | 新增：`pickBest`（纯函数，可单测） |
| `src/shared/keywords.ts` | 新增：默认词表 + `matchKeywords` |
| `src/main/capture.ts` | 改：新增 `captureScreenSilently`（`screencapture -x`） |
| `src/shared/parsing.ts` | 改：`HINTS.screen_scan` |
| `src/main/windows.ts` | 改：`showPreview` 支持 `suggestion` 形态 |
| `src/renderer/src/pages/PreviewCard.tsx` | 改：新增 `suggestion` phase + 三按钮 |
| `src/main/ipc.ts` | 改：`screen:scan` / `suggestion:accept` |
| `src/renderer/src/api.ts` | 改：`screenScan` / `suggestionAccept` |
| `src/main/hotkey.ts` | 改：支持第二个具名快捷键（扫描） |
| `src/main/index.ts` | 改：托盘"扫描当前屏幕"、初始化扫描快捷键 |
| `src/renderer/src/pages/Assistant.tsx` | 改：输入栏"扫描屏幕"按钮（开启时显示） |
| `src/renderer/src/pages/Settings.tsx` | 改：新增"屏幕感知建议"设置区 |
| `src/shared/types.ts` | 改：`AppSettings` 三字段 + `SourceType` 加 `screen_scan` |
| `src/renderer/src/labels.ts` | 改：`SOURCE_LABELS.screen_scan` |
| `src/main/db.ts` | 改：`getSettings/saveSettings` 三字段读写 |
| `test/screen-smoke.mjs` | 新增：`matchKeywords` / `pickBest` 单测 |
