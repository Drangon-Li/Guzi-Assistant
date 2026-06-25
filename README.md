# 纸壳助手（EShell）

个人事项捕获助手 —— 从聊天、通知、邮件、截图和屏幕里自动拎出待办，判断「哪些事是你的事」，用**确认式**交互帮你收进日程。macOS 桌面应用，基于 Electron + React。

> 本文档是项目的**实现参考**：讲清楚现在做到哪一步、整体怎么搭、每条链路怎么跑。面向继续开发的人。

---

## 一、当前进度（2026-06）

**已实现并可用：**
- 多来源捕获：剪贴板快捷键、框选截图、文件拖拽、托盘拖拽、访达右键、飞书机器人。
- AI 解析 + 归属判断 + 语义查重；助手对话式确认。
- 日程 / 时间轴 / 记忆 / 个人 / 设置 五个界面 + 右下角悬浮助手。
- **账号体系 + 托管解析网关 + 积分计费 + 充值收款**（"数据库即后端"，密钥只在服务端）。
- **屏幕感知本地优先管线**：本地 OCR + **设备端小模型**（Qwen2.5-1.5B）抽取，命中先进「记忆」历史，仅强信号主动弹精简卡，低置信自动上云 VLM 复核。

**已部署/已配置：**
- Supabase 项目 `rtgypddrknuylecqejmp`：库表、RLS、注册触发器、积分 RPC 全部就绪。
- `parse` Edge Function 已部署，密钥指向云雾聚合（yunwu.ai）：文本/对话用 `deepseek-v4-flash`，读图用 `qwen3.5-plus`。

**进行中 / 待联调：**
- chpay 收款 Edge Functions 已写好，需真实商户参数联调。

---

## 二、技术栈

Electron · electron-vite · React 19 · TypeScript · Tailwind CSS v4 · better-sqlite3（本地） · **node-llama-cpp（设备端小模型，仅主进程）** · Supabase（托管后端，Postgres + Auth + Edge Functions）

- **仅 macOS**：截图、访达快速操作、本地 OCR、前台应用检测都依赖 macOS API。
- 本地 OCR：macOS Apple Vision（`VNRecognizeTextRequest`），内嵌 Swift CLI 首次用 `swiftc` 编译缓存，**完全离线**。
- 本地小模型：`node-llama-cpp` + **Qwen2.5-1.5B-Instruct（GGUF / Q5_K_M）**，首次开启按需下载到 userData（支持本地文件导入 / 镜像源），grammar 约束 JSON 输出，关功能即卸载释放内存。
- 飞书：`@larksuiteoapi/node-sdk` 长连接，无需公网服务器。

---

## 三、整体架构

### 三进程 + IPC 单一事实源

```
渲染层(React)  ──invoke/on──>  preload(contextBridge, 通道白名单)  ──>  主进程(Node/Electron)
   src/renderer                    src/preload                            src/main
```

- **IPC 通道集中在 `src/shared/ipc-channels.ts`**：主进程 `ipcMain.handle` 注册、preload 白名单校验、渲染层 `api.ts` 调用都以此为准。新增通道必须登记，否则 preload 运行时拒绝（`test/ipc-channels-smoke.mjs` 校验三者一致）。
- 渲染层只通过 `src/renderer/src/api.ts`（`window.eshell.invoke/on` 的薄封装）和主进程通信，不直接碰 Node。

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
- 客户端默认内置我方 Supabase（`src/renderer/src/supabase.ts` 里 URL + publishable key，可公开，数据由 RLS 保护），**注册登录即用、零配置**；自建后端用 `VITE_ESHELL_SUPABASE_*` 覆盖。

---

## 四、核心链路

### 1. 捕获来源（都汇到同一套"解析 → 任务"内核）

| 来源 | 触发 | 入口 |
|---|---|---|
| 剪贴板 | 全局快捷键（默认 `Alt+C`） | `hotkey.ts` → `capture.ts` |
| 框选截图 | 菜单/快捷键 | `capture.ts`（`screencapture -i`） |
| 文件拖拽 | 拖进窗口 | `App.tsx` → `capture:files` |
| 托盘拖拽 | 拖到菜单栏图标 | `dropbox.ts` |
| 访达右键 | 「发送到 纸壳助手」 | `quickaction.ts` |
| 飞书机器人 | 转发消息/图 | `feishu.ts` |
| 屏幕感知 | 扫描快捷键 / 持续监控 | `screenwatch.ts` |

普通来源走 `capture.ts` 的 `submitPending` → 右下角预览卡确认 → `parser.parseToItems` → 建任务。

### 2. 解析与模型网关（`parser.ts`）

`parseToItems({ text, imageDataUrl?, hint })`：
1. 取用户档案 → `buildInstructions(profile, 已有任务, 归属先验)` 拼系统提示词（含"你是谁、常用名、哪些不是你的事"+ 已有任务用于查重）。
2. 调 `callModel(instructions, input, action)`：
   - **登录了** → 走托管网关 `viaGateway`：`POST {functionsBase}/parse`，带 `Authorization: Bearer <token>`，由 Edge Function 扣分 + 转发。
   - **没登录** → BYOK 回退 `viaDirect`：直连 `.env` 里的 `ESHELL_API_*`（OpenAI `/v1/responses`）。
3. `action`：含图 → `parse_vision`，纯文本 → `parse_text`；助手对话 → `chat`。

**模型分配（在 Edge Function `parse` 里按 action 选）**：
- `parse_vision`（含图）→ **qwen3.5-plus**（多模态读图）
- `parse_text` / `chat`（文本/对话）→ **deepseek-v4-flash**
- 由 secrets `ESHELL_LLM_MODEL` / `ESHELL_LLM_MODEL_VISION` 配置，上游 `ESHELL_LLM_BASE=https://yunwu.ai`。

**计费（`server/billing/credits.ts` + Postgres RPC）**：`parse_vision`=2 分、`parse_text`/`chat`=1 分、失败/跳过=0；先扣当月赠送（到期清零）再扣购买积分；`deduct_credits` 行锁防并发超扣。

### 3. 屏幕感知本地优先管线（`screenwatch.ts` + `local-model/` + `shared/local-model-schema.ts`）

> 设计目标：低延迟、不串味、不打扰、可控（不静默改日程）。**借鉴 MineContext / Recall / Screenpipe / Apple 数据探测器**：被动捕获为主、设备端抽取、少量主动。

```
                          手动:扫描快捷键 → scanOnce()
触发 ─────────────────────┤
                          自动:持续监控每 N 秒 → watchTick()
                                  ↓
   [自动] 隐私门:前台是排除名单 App(密码/银行/微信…) → 跳过，连截图都不做
                                  ↓
       静默截图 captureScreenSilently()（截光标所在「活动屏」，多显示器友好；原图用完即弃）
                                  ↓
   [自动] pHash 变化门:这帧和上帧几乎一样 → 跳过，不 OCR
                                  ↓
       本地 OCR（macOS Vision，离线免费）→ 文字（聊天界面前置「谁说的」转写）
                                  ↓
   [自动] 文本去重 + 内容冷却(同内容 10 分钟一次)
                                  ↓
   本地小模型抽取:OCR 全文按行去重切小块逐块喂 Qwen2.5-1.5B(grammar 约束 JSON)→ 合并去重
                                  ↓
   ├─ 高置信 + needsVlm=false → 本地出结论(不上云)
   └─ 低置信 / needsVlm=true → 自动上 VLM 网关复核(只传文字、扣分)
                                  ↓
                 命中 → 写入「记忆」历史(detections 表，被动留存)
                                  ↓
   仅当 强信号(解出具体日期) + 弹窗开关开 → 弹精简卡
                                  ↓
                 用户:同意(本地入库,不上云) / AI 解析(上云精修) / ✕(丢弃，历史仍留)
```

- **本地小模型抽取**（`local-model/extractor.ts` + `shared/local-model-schema.ts`）：grammar 强制合法 JSON、无日程返回 `[]` 防幻觉；满屏 UI 噪声会把小模型淹没，故 OCR 全文**按行去重切小块、逐块抽再合并去重**以提升召回。
- **确定性日期纠错**（`shared/local-time.ts`，纯函数可单测）：小模型对「下周一=哪天」等相对日期偏弱，用规则解析相对/显式日期纠正模型 isoTime 的日期部分（保留钟点），纯中文数字日期仍交模型。
- **模型获取**：首次开启按需下载 ~1.3GB GGUF（`localModelEndpoint` 可配镜像源，国内可填 `hf-mirror.com`），或在设置里**导入已下好的 `.gguf`**；关闭功能即 `dispose()` 释放内存，idle 自动卸载。
- **全屏感知**：不再按进程白名单过滤前台 App（进程门不可靠），只保留排除名单(隐私)与「不扫自己」两道门。
- **零静默**：不点「同意」绝不写日程/待确认；手动扫描即使本地没抽到也提供「AI 解析」兜底，确保任何内容都能上云精解。
- **桌宠联动**：扫描/解析中桌宠显示 Siri 式旋转光环替代加载卡（`pet/`），桌宠不可见时退回加载卡。
- **完全被动模式**：设置里关掉「检测到日程时弹窗提醒」→ 只进历史、不弹窗。

### 4. 归属判断（"哪些是你的事"）

模型按规则给每个事项 `belongs_to_user`（yes/no/uncertain）+ 置信度 + `suggested_action`；`shared/suggest.ts` 的 `pickBest` 过滤掉"不是你的"、置信度 < 0.4 不出建议（宁漏勿误）。用户把任务改判为"不是我的"时，`belonging-learn.ts` 从中沉淀个人归属词典。

---

## 五、数据模型

### 本地 SQLite（`<userData>/eshell.db`，`db.ts`）

| 表 | 作用 |
|---|---|
| `profile` | 用户档案（姓名/身份/昵称/组织/确认模式…） |
| `settings` | 应用设置（key-value） |
| `sources` | 捕获来源原文 + 全文检索（`sources_fts`，trigram/FTS5，退化 LIKE） |
| `tasks` | 任务（七种状态 + 归属 + 时间 + 来源引用） |
| `detections` | 屏幕感知本地检测历史（new/accepted/dismissed，上限 300 条） |

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

侧边栏导航：**日程 / 时间轴 / 记忆 / 个人 / 设置**，右下角常驻**悬浮助手**。

- **日程 `Schedule.tsx`**：今日/本周/全部视图；勾选完成有淡出收拢动画；待确认横幅、空态引导。
- **时间轴 `Timeline.tsx`**：天/周/月，倒计时卡，已结束折叠。
- **记忆 `Memory.tsx`**：可搜索历史来源 + **屏幕识别历史**（逐条同意/忽略）。
- **个人 `Account.tsx`**：账户登录 + 用户档案。
- **设置 `Settings.tsx`**：确认模式、快捷键、系统集成、飞书、屏幕感知（含弹窗开关）、权限、数据管理。
- **悬浮助手 `FloatingAssistant.tsx` + `AssistantChat.tsx`**：Notion 式右下角对话，点外部关闭。
- **预览卡 `PreviewCard.tsx`**：独立无边框窗（右下角），右侧滑入/滑出；剪贴板预览 / 解析结果 / 本地检测「检测到日程」三态。

界面层动效统一在 `styles.css`（缓动 `cubic-bezier(.2,.8,.2,1)`）：页面淡入淡出、卡片滑动、任务完成收拢、列表错位进场。

---

## 七、隐私

- 本地数据只在本机：`<userData>/eshell.db`，不自动上传。
- 屏幕原图**用完即弃**（OCR 后立即删）；屏幕静止/不含关键词时连云都不上；只可能上传文字。
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
    db.ts                SQLite（档案/设置/来源/任务/检测/FTS）
    capture.ts           剪贴板/截图/文件捕获、待提交项
    screenwatch.ts       屏幕感知管线 + 本地模型抽取 + detections + 自动 VLM 升级
    local-model/         设备端小模型封装：extractor.ts（下载/加载/extract/卸载/idle）+ paths.ts
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
    pages/               Schedule / Timeline / Memory / Account / Settings / PreviewCard / Onboarding / ScreenPermissionGate
    components/          FloatingAssistant / AssistantChat / AccountSection / RechargePanel / 各种 Modal …
    styles.css           设计 token + 动效
  shared/                主进程与渲染层共享（纯函数为主）
    types.ts parsing.ts ipc-channels.ts local-model-schema.ts local-time.ts suggest.ts
    phash.ts chat-layout.ts belonging-hints.ts belonging-learn.ts fts-query.ts
    ics.ts daily-brief.ts app-exclude.ts safe-path.ts shot-retention.ts task-filters.ts
server/                  与具体 DB 解耦的纯逻辑（Edge Function import）
  billing/credits.ts     积分计费核心
  chpay/sign.ts          chpay 签名
  db/schema.sql          Supabase Postgres 数据模型（建表/RLS/RPC/触发器）
supabase/functions/      Edge Functions（Deno）
  parse/                 模型解析网关（验身份 + 扣费 + 转发，按 action 选模型）
  pay-create/ pay-notify/ pay-query/   chpay 收款
test/                    纯函数冒烟测试（node 直接跑 .ts）
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
VITE_ESHELL_SUPABASE_URL=
VITE_ESHELL_SUPABASE_ANON_KEY=
# BYOK 直连回退（留空禁用；填了未登录时用，OpenAI /v1/responses 形状）
ESHELL_API_BASE=
ESHELL_API_KEY=
ESHELL_MODEL=
# 飞书自建应用（可选，也可在设置页填）
ESHELL_FEISHU_APP_ID=
ESHELL_FEISHU_APP_SECRET=
```

环境要求：macOS · Node ≥ 22.18（测试用原生 strip-types 直跑 `.ts`） · 屏幕感知需「屏幕录制」权限 · 首次本地 OCR 编译需 Xcode 命令行工具（`xcode-select --install`） · 本地模型首次开启需联网下载 ~1.3GB GGUF 或在设置里导入本地 `.gguf`。

---

## 十、托管后端部署（Supabase + 云雾）

```bash
# 1. 数据库（一次性）：在 Supabase SQL Editor 跑 server/db/schema.sql
# 2. Edge Function 密钥：
supabase secrets set \
  ESHELL_LLM_BASE=https://yunwu.ai \
  ESHELL_LLM_KEY=<云雾 relay key> \
  ESHELL_LLM_MODEL=deepseek-v4-flash \
  ESHELL_LLM_MODEL_VISION=qwen3.5-plus \
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
npm run test:unit        # 纯函数单测合集（无需 API，CI 必跑）
npm run test:localmodel  # 本地模型抽取/日期纯函数单测
npm run test:ipc         # IPC 通道白名单与源码一致性
npm run test:parser      # 解析归属判断冒烟（需 .env 配 API）
```

CI（`.github/workflows/ci.yml`）：PR 与 push 到 main 跑 `Typecheck & Build`。纯函数单测用 `node` 直跑 `.ts`（Node 原生 strip-types）。

---

## 十二、已知限制

- 本地小模型（1.5B）抽取有精度天花板：满屏噪声、相对日期（已用 `local-time.ts` 规则纠正部分）、归属判断在边界场景可能漏/误判；低置信会自动上 VLM 复核，手动扫描也可点「AI 解析」兜底。想更准可在设置里导入更大的本地模型（如 Qwen3-4B）。
- 本地切块抽取在满屏噪声页约需数秒（每块一次推理，上限 12 块）；只在屏幕变化时触发，自我节流。
- 「AI 解析」精修后入库的项，对应历史记录仍标记 `new`（未回填）；不影响功能。
- 屏幕监控的「AI 解析」只把 OCR **文字**发上游，不把截图发多模态（隐私优先，只传文字）。
- 模型「一键下载」若系统设了全局代理仍可能经代理；要完全免代理用设置里的**导入本地文件**或填镜像源。
