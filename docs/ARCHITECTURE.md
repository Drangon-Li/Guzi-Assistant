# 谷子助手 · 架构与实现参考

> 本文档是项目的**实现参考**：讲清楚现在做到哪一步、整体怎么搭、每条链路怎么跑。面向继续开发的人。
> 面向用户的介绍与下载见 [README.md](../README.md)。



---

## 一、当前进度（2026-08）

**v0.2.0 已发布：**
- 多来源捕获：剪贴板快捷键、框选截图、文件拖拽、托盘拖拽、访达右键、飞书机器人。
- AI 解析 + 归属判断 + 语义查重；助手对话式确认。
- 日程 / 时间轴 / 记忆 / 历史 / 个人 / 设置六个界面 + 右下角悬浮助手。
- **账号体系 + 托管解析网关 + 积分计费 + 充值收款**（"数据库即后端"，密钥只在服务端）。
- **legacy 屏幕感知管线**：本地截图/pHash/OCR/脱敏，判断走云端解析；默认关闭，可选日程深度确认和截图留存。
- **Computer History v2**：默认关闭的原生活动采集器，记录 App、窗口、AX 焦点、点击、拖拽、快捷键、选择和输入 burst 的元数据；输入只保存长度/动作类型，不保存键盘正文或完整 URL。
- **History 存储与摘要**：JSONL segment + SQLite metadata/summary index，崩溃恢复、48 小时保留、范围清理；本地确定性生成 10 分钟工作摘要，再汇总为 6 小时摘要。
- **工作记录与日报**：History 摘要可派生带任务、真实起止时间、置信度和证据来源的工作记录；旧 OCR 记录保留并标记 legacy；一键/每日定时生成工作日报，支持导出。
- **历史查询与 MCP**：History 页面支持时间范围、摘要、App 黑名单、暂停/恢复和清理；MCP 仅监听 `127.0.0.1`，使用 Bearer token，默认不返回敏感原文。
- **个人记忆**：基本画像（手动维护）+ 近期行为画像（AI 归纳），注入解析/助手 prompt，越用越懂用户。
- **隐私强化**：安全输入、私密浏览和排除 App 只产生 suppressed 计数；OCR/摘要内容上云前敏感脱敏；数据可按时间范围导出 JSON。

**已部署/已配置：**
- Supabase 项目 `rtgypddrknuylecqejmp`：库表、RLS、注册触发器、积分 RPC 全部就绪。
- `parse` Edge Function 已部署，密钥指向云雾聚合（yunwu.ai）：文本/对话用 `deepseek-v4-flash`，读图用 `qwen3.5-plus`。

**仍需真机观察 / 联调：**
- Accessibility、Input Monitoring 权限矩阵，原生 collector 长时间 CPU/内存/WindowServer 和输入延迟观察。
- chpay 收款 Edge Functions 已写好，需真实商户参数联调。

---

## 二、技术栈

Electron · electron-vite · React 19 · TypeScript · Tailwind CSS v4 · better-sqlite3（本地） · Supabase（托管后端，Postgres + Auth + Edge Functions）

- **仅 macOS**：截图、访达快速操作、本地 OCR、前台应用检测都依赖 macOS API。
- 本地 OCR：macOS Apple Vision（`VNRecognizeTextRequest`），内嵌 Swift CLI 首次用 `swiftc` 编译缓存，**完全离线**。
- 飞书：`@larksuiteoapi/node-sdk` 长连接，无需公网服务器。

---

## 三、整体架构

### 三进程 + IPC 单一事实源

```
渲染层(React)  ──invoke/on──>  preload(contextBridge, 通道白名单)  ──>  主进程(Node/Electron)
   src/renderer                    src/preload                            src/main
```

- **IPC 通道集中在 `src/shared/ipc-channels.ts`**：主进程 `ipcMain.handle` 注册、preload 白名单校验、渲染层 `api.ts` 调用都以此为准。新增通道必须登记，否则 preload 运行时拒绝（`test/ipc-channels-smoke.mjs` 校验三者一致）。
- 渲染层只通过 `src/renderer/src/api.ts`（`window.guziAssistant.invoke/on` 的薄封装）和主进程通信，不直接碰 Node。

### Computer History v2 数据流

```
macOS 原生 collector
  App/窗口/AX/点击/拖拽/快捷键/选择/输入长度
          │  privacy gate + dedupe/rate limit/backoff
          ▼
JSONL segment（原始事件元数据） + SQLite index（metadata/summary）
          │  48 小时 retention / crash recovery
          ▼
10 分钟本地摘要 ──> 6 小时摘要 ──> History 派生工作记录
          │                 │                  │
          └──── History 页面 / IPC / MCP ─────┘
```

- `historyV2Enabled` 控制原生采集，`historyDerivedWorkEnabled` 单独控制摘要派生工作记录；两个开关默认关闭、可独立回滚。
- 原始事件只进入本机 `<userData>/history-v2/segments/<segment-id>/events.jsonl`，SQLite 保存可恢复的索引和摘要元数据。
- 摘要 prompt 将事件内容标记为 observed data，不把事件中的文本当作可执行指令。

### 数据库即后端（托管侧）

模型密钥**不能塞进客户端**（所有客户端共用一个 key，一旦被破解就被盗刷）。所以：

```
客户端(带 Supabase 登录态)
   │  fetch /functions/v1/parse
   ▼
Supabase Edge Function (parse)   ← 密钥只在这里(service-role / relay key)
   │  ① 验 JWT 身份  ② 预检积分  ③ 转发上游模型  ④ 原子扣费 + 写流水
   ▼
上游聚合 API (yunwu.ai, OpenAI 兼容)
```

- Supabase = Postgres（库表/积分）+ Auth（登录）+ Edge Functions（前台逻辑）+ Storage。
- 客户端默认内置我方 Supabase（`src/renderer/src/supabase.ts` 里 URL + publishable key，可公开，数据由 RLS 保护），**注册登录即用、零配置**；自建后端用 `VITE_GUZI_ASSISTANT_SUPABASE_*` 覆盖。

---

## 四、核心链路

### 1. 捕获来源（都汇到同一套"解析 → 任务"内核）

| 来源 | 触发 | 入口 |
|---|---|---|
| 剪贴板 | 全局快捷键（默认 `Alt+C`） | `hotkey.ts` → `capture.ts` |
| 框选截图 | 菜单/快捷键 | `capture.ts`（`screencapture -i`） |
| 文件拖拽 | 拖进窗口 | `App.tsx` → `capture:files` |
| 托盘拖拽 | 拖到菜单栏图标 | `dropbox.ts` |
| 访达右键 | 「发送到 谷子助手」 | `quickaction.ts` |
| 飞书机器人 | 转发消息/图 | `feishu.ts` |
| 屏幕感知 | 扫描快捷键 / 持续监控 | `screenwatch.ts` |

普通来源走 `capture.ts` 的 `submitPending` → 右下角预览卡确认 → `parser.parseToItems` → 建任务。

### 2. 解析与模型网关（`parser.ts`）

`parseToItems({ text, imageDataUrl?, hint })`：
1. 取用户档案 → `buildInstructions(profile, 已有任务, 归属先验)` 拼系统提示词（含"你是谁、常用名、哪些不是你的事"+ 已有任务用于查重）。
2. 调 `callModel(instructions, input, action)`：
   - **登录了** → 走托管网关 `viaGateway`：`POST {functionsBase}/parse`，带 `Authorization: Bearer <token>`，由 Edge Function 扣分 + 转发。
   - **没登录** → BYOK 回退 `viaDirect`：直连 `.env` 里的 `GUZI_ASSISTANT_API_*`（OpenAI `/v1/responses`；兼容旧 `ESHELL_API_*`）。
3. `action`：含图 → `parse_vision`，纯文本 → `parse_text`；助手对话 → `chat`。

**模型分配（在 Edge Function `parse` 里按 action 选）**：
- `parse_vision`（含图）→ **qwen3.5-plus**（多模态读图）
- `parse_text` / `chat`（文本/对话）→ **deepseek-v4-flash**
- 新部署使用 `GUZI_ASSISTANT_LLM_*` secrets；旧 `ESHELL_LLM_*` 仍作为升级兼容回退。

**计费（`server/billing/credits.ts` + Postgres RPC）**：`parse_vision`=2 分、`parse_text`/`chat`=1 分、失败/跳过=0；先扣当月赠送（到期清零）再扣购买积分；`deduct_credits` 行锁防并发超扣。

### 3. legacy 屏幕感知管线（`screenwatch.ts`）

> 设计目标：不串味、不打扰、可控（不静默改日程）。这一节描述旧的 OCR/截图路径；它与默认关闭的 Computer History v2 原生事件路径并行存在，两个开关互不替代。

```
                          手动:扫描快捷键 → scanOnce()
触发 ─────────────────────┤
                          自动:持续监控每 N 秒 → watchTick()
                                  ↓
   [自动] 就绪门:未登录(且未配 BYOK)/无档案 → 静默跳过，不截图不 OCR
                                  ↓
   [自动] 隐私门:前台是排除名单 App(密码/银行/微信…) → 跳过，连截图都不做
                                  ↓
       静默截图 captureScreenSilently()（截光标所在「活动屏」，多显示器友好；原图用完即弃）
                                  ↓
   [自动] pHash 变化门:这帧和上帧几乎一样 → 跳过，不 OCR
                                  ↓
   [自动] 键鼠闲置 ≥2 分钟（人不在电脑前）→ 整轮跳过，不截图不统计
                                  ↓
       本地 OCR（macOS Vision，离线免费）→ 文字（聊天界面前置「谁说的」转写）
                                  ↓
       敏感脱敏 redactSensitive：API key/私钥/JWT/证件/卡号值打码后才可出设备
                                  ↓
   [自动] 文本去重 + 内容冷却(同内容 10 分钟一次)
                                  ↓
       云端解析（只传脱敏文字、扣分）→ 待办候选（多任务）+ work_summary/focus_task 便车
                                  ↓
   [可选] 日程深度确认：检出带时间候选 → 当帧截图裁前景发视觉模型逐项复核（截图上云，opt-in）
                                  ↓
                 命中 → 写入「记忆」历史(detections 表，被动留存)
                                  ↓
   仅当 强信号(解出具体日期) + 弹窗开关开 → 逐张弹精简卡（多任务队列）
                                  ↓
                 用户:同意(入库) / ✕(丢弃，历史仍留)
```

- **云端解析**：`HINTS.screen_scan` 提示词负责去噪（菜单/侧栏文字）、旧消息过滤（非今天发送的聊天不提取）、「A 至 B」截止语义；多任务一次全部返回，卡片逐张确认。
- **legacy 工作记录便车**：同一次识别调用顺带返回 `work_summary`（在做什么一句话）与 `focus_task`（任务级标签），零额外积分；无信息量画面返回 null；1 分钟节流 + 同活动去重，展示端按时段聚合（`groupWorkPeriods`）。History v2 的工作记录由 10 分钟摘要独立派生，见下一节。
- **深度确认（opt-in）**：文字层检出「有具体时间且非明确他人」的候选时，当帧截图裁前景发视觉模型逐项复核，以视觉结果为准（空=文字层假阳性丢弃）。注意此路径截图会上云，且文字层的无时间弱候选会被替换掉。
- **全屏感知**：不按进程白名单过滤前台 App（进程门不可靠），只保留排除名单(隐私)与「不扫自己」两道门。
- **零静默**：不点「同意」绝不写日程/待确认；手动扫描无命中时明确提示「未发现可添加的日程」。
- **桌宠联动**：扫描/解析中桌宠显示 Siri 式旋转光环替代加载卡（`pet/`），桌宠不可见时退回加载卡。
- **完全被动模式**：设置里关掉「检测到日程时弹窗提醒」→ 只进历史、不弹窗。

### 3.1 Computer History v2 原生采集与摘要

开启设置中的「History v2 原生活动记录」后，macOS helper 以长驻 collector 采集低敏元数据：前台 App/窗口、AX 焦点和属性变化、点击、右键、拖拽、快捷键、选择变化、输入 burst 长度与动作类型。collector 还提供 heartbeat、watchdog、有限重启、degraded 状态、去重、限流和按 bundle backoff。

- **隐私门**：`AXSecureTextField`/密码角色、AX 查询失败、私密浏览、用户选择的 App 黑名单和网站 host 排除都 fail-closed；这些情况只递增 suppressed 计数，不写入普通事件流。
- **浏览器边界**：只保留 `http/https` 的 host；完整 URL、路径、查询参数、凭据和键盘正文在 helper、IPC、schema 三层拒绝。
- **存储**：每 10 分钟一个 UTC segment，事件写入 JSONL，`metadata.json` 与 SQLite index 双写并在重启时协调；只保留最近 48 小时，边界时刻按明确规则处理。
- **摘要**：10 分钟摘要使用确定性本地统计，包含时间范围、主要工作焦点、进展、App、活动类型、置信度和来源 segment；6 小时摘要只消费 10 分钟摘要，可选在线模型补充并带失败退避/幂等。
- **工作记录**：开启「从摘要派生工作记录」后，10 分钟摘要写入 `work_records`，任务标签、真实 `startAt/endAt`、摘要 hash、证据数量和来源保持一致；旧 OCR 记录不删除，标记为 `legacy/ocr`。
- **查询与清理**：History 页面和 MCP 查询顺序为 6 小时摘要 → 10 分钟摘要 → 必要时 segment 统计；支持暂停/恢复、按时间范围删除和全部清空。MCP 仅监听 `127.0.0.1` 并要求 Bearer token。

### 4. 工作日报与个人记忆（`report.ts` / `report-scheduler.ts` / `personal-memory.ts` / `shared/work-report.ts`）

- **工作记录 → 日报**：当日工作记录（时段聚合）+ 应用使用时长 + 任务完成情况 → 云端撰写 Markdown 日报（今日概览/主要工作/完成事项/时间分配/明日计划）；`dailyReportTime` 设置可每日定时自动生成并系统通知。
- **任务专注**：legacy 记录继续使用 `focus_task` 模型归并；History v2 使用摘要中的稳定 `focusTask`，并将同一任务的真实时间区间写入 `work_records`。`focusDurations()` 按真实连续段累计，不再给每条记录固定增加时长；日报页可添加自定义任务名（进模型候选）/删除（隐藏并剔出候选），形成人工校正闭环（`focus_tasks` 表）。
- **来源与兼容**：History 派生记录保存 `segment_id`、`summary_hash`、`confidence`、`evidence_count`、`derived_by` 等追溯字段，按 segment/hash 幂等去重；旧 OCR 记录保留并标记 `legacy`，两个路径可以独立回滚。
- **个人记忆两段式**：基本画像（用户身份的长期定义，手动维护）+ 近期行为画像（AI 从近 14 天活动归纳，可刷新/编辑）；`personalMemoryText()` 拼接注入解析与助手系统提示词。

### 5. 归属判断（"哪些是你的事"）

模型按规则给每个事项 `belongs_to_user`（yes/no/uncertain）+ 置信度 + `suggested_action`；`shared/suggest.ts` 的 `pickBest` 过滤掉"不是你的"、置信度 < 0.4 不出建议（宁漏勿误）。用户把任务改判为"不是我的"时，`belonging-learn.ts` 从中沉淀个人归属词典。

---

## 五、数据模型

### 本地 SQLite（`<userData>/eshell.db`，兼容保留的历史文件名，`db.ts`）

| 表 | 作用 |
|---|---|
| `profile` | 用户档案（姓名/身份/昵称/组织/确认模式…） |
| `settings` | 应用设置（key-value） |
| `sources` | 捕获来源原文 + 全文检索（`sources_fts`，trigram/FTS5，退化 LIKE） |
| `tasks` | 任务（七种状态 + 归属 + 时间 + 来源引用） |
| `detections` | 屏幕感知本地检测历史（new/accepted/dismissed，上限 300 条） |
| `work_records` | 工作记录：内容、任务标签、真实起止时间、来源、摘要 hash 和证据（上限 5000 条） |
| `app_usage` | 前台应用使用时长（按天累计，只存名称+秒数，排除自身） |
| `reports` | AI 生成的工作日报（Markdown） |
| `personal_memory` | 个人画像单行表（base=基本画像 / content=近期画像） |
| `focus_tasks` | 任务专注的自定义/隐藏偏好（校正模型归并） |

History v2 另外使用两张 SQLite 索引表：

| 表 | 作用 |
|---|---|
| `history_segments` | JSONL segment 的时间范围、事件计数、suppressed 计数、应用/活动统计和 metadata 路径 |
| `history_summaries` | 10 分钟/6 小时摘要、来源 segment、时间范围、任务焦点、置信度、模型状态和摘要 hash |

原始 History 事件不放进 SQLite 正文表，而是保存在 `<userData>/history-v2/segments/*/events.jsonl`；普通事件 schema 不接受键盘正文、选中文本或完整 URL。`metadata.json` 是可恢复的磁盘 sidecar，启动时以 SQLite 索引和 JSONL 重算结果协调，避免旧便签覆盖新账本。

### 托管 Postgres（Supabase，`server/db/schema.sql`）

| 表 | 作用 |
|---|---|
| `profiles` | auth.users 之上的应用层档案 |
| `credits` | 积分余额（当月赠送 + 购买，月度重置） |
| `credit_ledger` | 积分流水（每次扣费/赠送/充值一行） |
| `orders` | chpay 充值订单 |

- RPC：`deduct_credits` / `add_credits` / `activate_membership`（service-role 调用，行锁原子）。
- 触发器：`handle_new_user` 新用户自动建 profile + credits（默认每月赠 1000）。
- RLS：用户只读自己；所有写入走 service-role 后端，客户端改不了余额。

---

## 六、界面

侧边栏导航：**今日 / 日程 / 日报 / 记忆 / 历史 / 个人 / 设置**，右下角常驻**悬浮助手**。首次运行有三步引导（`Welcome.tsx`）。

- **今日 `Home.tsx`**：主界面：今日概览四指标、24h 时段热力、最近工作记录、扫描/日报快捷入口。
- **日程 `Schedule.tsx`**：列表/时间轴双视图。列表：今日/近三天/本周/全部筛选、勾选完成动画、待确认横幅、空态引导；时间轴（`Timeline.tsx`，原独立页并入）：天/周/月分组、倒计时卡、已结束折叠。
- **日报 `Reports.tsx`**：工作记录时间线（限高滚动 + 小时锚点跳转）、应用使用时长、任务专注（可增删校正）、生成/回看/导出工作日报。
- **记忆 `Memory.tsx`**：三 tab——活动（按天时段流水）/ 个人记忆（基本+近期两段画像，可编辑刷新）/ 历史（来源检索 + 屏幕识别历史逐条同意/忽略）。
- **历史 `History.tsx`**：展示 6 小时摘要、10 分钟活动块和未摘要 segment 统计；支持时间范围/任务线索/App 搜索、事件类型统计展开、暂停/恢复、立即摘要、App 黑名单选择和 48 小时范围清理。
- **个人 `Account.tsx`**：账户登录 + 用户档案。
- **设置 `Settings.tsx`**：确认模式、快捷键、系统集成、飞书、legacy 屏幕感知、独立 History v2/派生开关、collector 健康状态、权限和数据管理。二值设置统一使用可访问 Toggle。
- **悬浮助手 `FloatingAssistant.tsx` + `AssistantChat.tsx`**：Notion 式右下角对话，点外部关闭。
- **预览卡 `PreviewCard.tsx`**：独立无边框窗（右下角），右侧滑入/滑出；剪贴板预览 / 解析结果 / 屏幕检测「检测到日程」三态。

- 共享小组件在 `components/ui.tsx`：Section 卡片区块 / Segmented 分段切换 / DayNav 日期翻页 / BarRow 占比条——重复样式模式只改这一处。

界面层动效统一在 `styles.css`（缓动 `cubic-bezier(.2,.8,.2,1)`）：页面淡入淡出、卡片滑动、任务完成收拢、列表错位进场。主题品牌色 token（`--color-brand` 暖橙，取自 logo）也在 `styles.css`，深色覆盖见 `theme.css`。

---

## 七、隐私

- 本地数据只在本机：`<userData>/eshell.db`（兼容保留的历史文件名），不自动上传。
- 屏幕原图**用完即弃**（OCR 后立即删）；屏幕静止/内容未变/冷却期内/人不在电脑前连云都不上；默认只上传 OCR **文字**（且已脱敏），仅「日程深度确认」开启时上传当帧前景裁剪图。
- 上云前脱敏（`shared/sensitive.ts`）：API key/私钥/JWT/身份证/银行卡/密码值替换为 `[已隐去·类型]` 占位符（模式参考 gitleaks / detect-secrets / Presidio；手机号不打码——常是任务必要联系信息）。
- History v2 原生 collector 不保存键盘正文、选中文本或完整 URL；输入只保存长度/动作类型，浏览器只保留 `http/https` host。
- 密码/安全输入、私密浏览、排除 App、AX 查询失败等情况 fail-closed，只保留 suppressed 计数，不进入普通摘要或工作记录。
- History 原始 JSONL、metadata 和摘要默认只保留最近 48 小时；删除/清空会同时删除 segment 文件、索引、摘要和 History 派生工作记录，旧 legacy OCR 记录按兼容规则保留。
- History MCP 只绑定 `127.0.0.1`，必须使用 Bearer token；查询默认返回摘要统计，不返回敏感原文。
- 设置 → 数据 可按时间范围导出工作记录/日报/应用时长/检测历史为 JSON。
- 排除名单 App 在前台时连截图都不做。
- 截图持久化默认**关**（opt-in）：开启才存**加密缩略图**（系统钥匙串）+ 保留期到期自动清，原图始终不留。
- macOS 录屏指示器为系统强制行为，无法关闭。
- 设置页可一键清除全部本地数据。

---

## 八、目录结构

```
src/
  main/                  Electron 主进程
    index.ts             应用生命周期 / 托盘 / 单实例
    windows.ts           主窗 + 预览窗
    ipc.ts               所有 IPC handler
    db.ts                SQLite（档案/设置/来源/任务/检测/History 索引/FTS）
    db-migrations.ts     增量迁移 work_records 与 History 追溯字段
    capture.ts           剪贴板/截图/文件捕获、待提交项
    screenwatch.ts       legacy 屏幕感知 + History 生命周期/摘要/双写
    frontapp.ts          macOS 原生前台/AX/鼠标/键盘元数据 collector
    native-helper-cache.ts  原生 helper 源码 hash 校验与安全重编
    history/              event schema / JSONL store / retention / summarizer / query / MCP / work derivation
    report.ts report-scheduler.ts personal-memory.ts   工作日报生成/每日定时/个人画像归纳
    pet/                 桌宠窗口（静态品牌标 + Siri 式扫描光环，移植自 openpets）
    ocr.ts               macOS Vision 本地 OCR（内嵌 Swift）
    parser.ts            解析：托管网关 / BYOK 回退、按 action 选路
    assistant.ts         助手对话
    session.ts           Supabase 登录态推给主进程
    payment.ts           chpay 支付窗
    shotvault.ts         截图加密存储（#52/#53）
    feishu.ts hotkey.ts quickaction.ts frontapp.ts sensitive.ts dropbox.ts export.ts dailybrief-scheduler.ts env.ts
  preload/               contextBridge 桥接 + 通道白名单
  renderer/src/
    App.tsx              外壳 + 导航 + 悬浮助手
    api.ts               IPC 客户端封装
    supabase.ts          Supabase 客户端 + functionsBase
    pages/               Home / Schedule(含 Timeline 视图) / Reports / Memory / History / Account / Settings / PreviewCard / Welcome / Onboarding / ScreenPermissionGate
    components/          ui.tsx(共享小组件) / FloatingAssistant / AssistantChat / AccountSection / RechargePanel / 各种 Modal …
    styles.css           设计 token + 动效
  shared/                主进程与渲染层共享（纯函数为主）
    types.ts parsing.ts ipc-channels.ts suggest.ts work-report.ts sensitive.ts history.ts activity-events.ts
    phash.ts chat-layout.ts belonging-hints.ts belonging-learn.ts fts-query.ts
    ics.ts daily-brief.ts app-exclude.ts safe-path.ts shot-retention.ts task-filters.ts
server/                  与具体 DB 解耦的纯逻辑（Edge Function import）
  billing/credits.ts     积分计费核心
  chpay/sign.ts          chpay 签名
  db/schema.sql          Supabase Postgres 数据模型（建表/RLS/RPC/触发器）
supabase/functions/      Edge Functions（Deno）
  parse/                 模型解析网关（验身份 + 扣费 + 转发，按 action 选模型）
  pay-create/ pay-notify/ pay-query/   chpay 收款
test/                    纯函数、History、collector、MCP、迁移和 UI 冒烟测试
docs/                    设计与实现文档
```

---

## 九、本地开发

```bash
npm install
npm run dev          # 开发模式（electron-vite）
```

- 客户端默认连内置 Supabase，登录即用。想纯测模型 pipeline 不走网关/计费，可在 `.env` 配 BYOK 回退（未登录时生效）：

```
# 托管后端（可选，自建才填；publishable key 可公开）
VITE_GUZI_ASSISTANT_SUPABASE_URL=
VITE_GUZI_ASSISTANT_SUPABASE_ANON_KEY=
# BYOK 直连回退（留空禁用；填了未登录时用，OpenAI /v1/responses 形状）
GUZI_ASSISTANT_API_BASE=
GUZI_ASSISTANT_API_KEY=
GUZI_ASSISTANT_MODEL=
# 飞书自建应用（可选，也可在设置页填）
GUZI_ASSISTANT_FEISHU_APP_ID=
GUZI_ASSISTANT_FEISHU_APP_SECRET=
```

环境要求：macOS · Node ≥ 22.18 · 屏幕感知需「屏幕录制」权限 · History v2 需要 Accessibility 和 Input Monitoring 权限 · 首次本地 OCR/native helper 编译需 Xcode 命令行工具（`xcode-select --install`）。

### 构建和发布包

```bash
npm run build       # 只构建 Electron 主进程、preload 和 renderer
npm run pack:dir    # 生成未签名的 arm64 .app 目录
npm run pack:mac    # 生成 arm64 DMG + ZIP
```

当前公开版本是 [v0.2.0](https://github.com/Chinese-Dragon-Li/Guzi-Assistant/releases/tag/v0.2.0)。安装包未使用 Apple Developer ID 签名或公证；Apple Silicon Mac 首次打开如遇 Gatekeeper，请在 Finder 中右键选择「打开」。

---

## 十、托管后端部署（Supabase + 云雾）

```bash
# 1. 数据库（一次性）：在 Supabase SQL Editor 跑 server/db/schema.sql
# 2. Edge Function 密钥：
supabase secrets set \
  GUZI_ASSISTANT_LLM_BASE=https://yunwu.ai \
  GUZI_ASSISTANT_LLM_KEY=<云雾 relay key> \
  GUZI_ASSISTANT_LLM_MODEL=deepseek-v4-flash \
  GUZI_ASSISTANT_LLM_MODEL_VISION=qwen3.5-plus \
  --project-ref <ref>
# 3. 部署：
supabase functions deploy parse --project-ref <ref>
#   收款（联调时）：supabase functions deploy pay-create / pay-notify / pay-query
```

> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 由平台自动注入。部署/设密钥需 Supabase **访问令牌**（账号设置生成），非库密钥。

---

## 十一、脚本与 CI

```bash
npm run typecheck        # 类型检查（main + renderer 两个 tsconfig）
npm run build            # 构建
npm test                 # 全部 smoke（自动发现 test/*-smoke.mjs，无需 API；= test:unit）
npm test history         # 只跑文件名含 history 的用例（可给多个关键词）
npm test -- --verbose    # 打印每个用例的完整输出，而非只打印失败的
npm run test:parser      # 解析归属判断冒烟（需 .env 配 API）
npm test -- --all        # 连需要 .env/API 的用例一起跑
```

测试入口是 `test/run.mjs`：遍历 `test/*-smoke.mjs` **全部跑完再汇总**，不会像旧的 `&&` 链那样中途短路，
新增用例放进 `test/` 即自动纳入，不必登记到 `package.json`。需要真实 API 凭据的用例记在 run.mjs 的 `NEEDS_API` 里，默认跳过。

CI（`.github/workflows/ci.yml`）：PR 与 push 到 main 跑 `Typecheck & Build`。`npm ci` 的 Electron postinstall 会先准备 native addon，CI 随后执行 `npm rebuild better-sqlite3` 切换到 Node 测试 ABI，再运行 `typecheck`、`test:unit` 和 `build`。本机若 Electron 与宿主 Node ABI 不同，可先执行 `npm rebuild better-sqlite3` 跑 Node smoke，打包时 Electron Builder 会重新按 Electron ABI 构建。

---

## 十二、已知限制

- legacy 屏幕感知只把脱敏 OCR **文字**发上游，不把截图发多模态（除非显式开启日程深度确认）；模型看不到版面/坐标，个别依赖布局的场景可能漏/误判。
- History v2 的原生 collector 需要用户授予 Accessibility/Input Monitoring；权限不足时会显示 `unavailable/degraded`，安全输入仍按 suppressed 计数处理。
- 原生 helper 首次运行可能需要 `xcrun clang` 编译；启动时按源码 hash 校验缓存，源码变化会自动重编。真实 macOS 权限矩阵和长时间 WindowServer/输入延迟仍需真机观察。
- 检测必须联网 + 登录（或 BYOK）：每次「屏幕出现新内容且冷却过期」消耗一次积分，pHash 门/文本去重/10 分钟冷却/App 排除名单是成本挡板；未登录时监控静默暂停。
- 检测响应为云端往返（数秒），手动扫描期间以桌宠光环/加载卡示意。
- 任务证据缩略图为整屏截图（不再逐行裁剪「依据行」）。
- 深度确认开启时以视觉结果为准：文字层检出的无时间弱候选会被替换掉、不进历史。
- 任务专注标签只覆盖功能启用后的新工作记录；存量 legacy 记录无 task 标签时不参与 History 专注统计。
- History 默认关闭，且只保留最近 48 小时；启用派生工作记录后，摘要生成仍可能受本地资源或在线模型可用性影响。
