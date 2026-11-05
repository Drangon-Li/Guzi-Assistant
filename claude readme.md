# 谷子助手 — 代码结构速查（给 AI 看的）

> 这份文件是给 AI 助手快速建立代码认知用的，不对外。对外介绍看 `README.md`。
> 进仓库改代码前先读这里，不要从零扫一遍目录。
>
> **改了结构就顺手更新这里**——过期的地图比没有地图更糟。

---

## 一句话

macOS 桌面端个人事项捕获助手。核心链路是**捕获 → 判断 → 收进日程**：从剪贴板、截图、屏幕感知里抓出"像日程的东西"，让模型判断该不该记，确认后落进任务库。其余功能（作息、专注、打卡、成就、记事本）都是**可停用的插件**，默认一个都不开。

## 技术栈

Electron 38 + electron-vite + React 19 + TypeScript + Tailwind v4 + better-sqlite3（本地库）+ Supabase（云端后端 / 订阅 / 模型代理，**当前暂停**）。

**当前是本地模式**：`src/shared/hosted-service.ts` 的 `HOSTED_SERVICE_ENABLED = false`，渲染层 `hasBackend` 为假——没有登录、积分、订阅和应用内反馈，解析只走用户在「设置 → 助手 → 模型」里填的 API。新加的界面文案凡是提到积分、登录、云端，都要按 `hasBackend` 分两套写；恢复托管服务时改回 `true`（`test/hosted-service-smoke.mjs` 会提醒同步）。

---

## 三进程与目录

```
src/
  main/        主进程：Node 环境，能碰文件系统、原生 API、数据库
  preload/     桥：contextBridge 暴露白名单 API 给渲染层
  renderer/    渲染层：React 界面
  shared/      三方共用的纯类型与纯函数（无副作用、可单测）
test/          *-smoke.mjs 冒烟测试，直接跑 .ts 源码
resources/     托盘图标等打包资源
server/        Supabase Edge Functions
```

**路径别名**：`@shared/*` → `src/shared/*`（主进程和渲染层都可用）；`@/*` → `src/renderer/src/*`（仅渲染层）。
**preload 构建没有别名**，必须写相对路径 `../shared/xxx`。

TS 分两个 project：`tsconfig.node.json`（main + preload + shared + server）、`tsconfig.web.json`（renderer + shared）。`npm run typecheck` 两个都跑。

---

## 三条铁律

违反这三条会在测试里直接挂，别绕。

### 1. IPC 通道单一事实源

`src/shared/ipc-channels.ts` 是唯一登记处。新增通道必须写进 `INVOKE_CHANNELS` / `EVENT_CHANNELS`，否则 preload 白名单会拒绝调用。`test/ipc-channels-smoke.mjs` 会校验这张表和源码里实际注册/调用的一致。

主进程注册按领域拆在 `src/main/ipc/` 下（`settings` `voice` `capture` `task` `activity` `app`，共约 115 个 handler），
`src/main/ipc.ts` 只是入口。所有 handler 都经 `ipc/register.ts` 的 `ipcMain` 包装注册（内容纪元校验 + 退出期在途工作登记），
**不要直接用 electron 的 `ipcMain.handle`**。

### 2. 插件的"声明"和"实现"必须两边都有

- **声明**：`src/shared/plugin-registry.ts` 的 manifest（单一事实源）
- **主进程实现**：`src/main/plugins/<id>/index.ts`
- **渲染层实现**：`src/renderer/src/plugins/<id>/index.tsx`，注册进 `src/renderer/src/plugins/index.ts`

`test/plugin-smoke.mjs` 卡住"声明了没实现"和"实现了没声明"两个方向。

### 3. 插件的两条前缀边界

- 表名必须 `p_<id>_` 开头，且在 manifest 的 `storage.tables` 里列全（卸载按这个删数据）
- IPC 通道必须 `plugin:<id>:<action>` 形状；preload 按形状放行，是否启用由主进程决定

---

## 插件系统

### 扩展点（manifest 的 `contributes`，见 `plugin-manifest.ts:60`）

| 字段 | 作用 |
|---|---|
| `nav` | 侧边栏导航项。核心页占 order 0–99，插件从 100 起，且互不相同 |
| `homeCards` | 今日页卡片 id，渲染层注册表映射到组件 |
| `achievementCounters` | 是否向「成就」插件供计数器 |
| `assistantActions` | 可被自然语言驱动的动作（桌宠 / 悬浮助手 / 快捷提问都能用） |
| `emits` / `listens` | 插件间事件，完整名 `<plugin>:<event>` |
| `contentSinks` | 能接住核心交来的内容（日报的「保存到…」按这个列） |
| `assistantContext` | 向对话提示词贡献只读上下文 |

加上 `storage.tables` 和隐式的 IPC 命名空间。

**刻意没有「设置分区」这个贡献点**：插件的配置放在插件自己的页面里，跟着插件走，停用后核心设置页不留空分区。

### handler 注册

主进程模块导出 `handlers` 对象，`src/main/plugins/index.ts:89` 遍历它自动注册成 `plugin:<id>:<action>`。**加个 key 就够，不需要另外登记白名单。**

渲染层调用：`api.plugin<T>('<id>', '<action>', ...args)`。

### assistantActions 怎么进提示词

`assistantActionsBlock()`（`plugin-manifest.ts:294`）把**已启用**插件的动作拼成文本 → `main/assistant.ts:157` 传给 `buildAssistantInstructions()` → `parsing.ts:206` 的 `pluginActionsSection()` 包成提示词段落。

没有启用的插件整段省略——与其告诉模型"你还能做这些但都不可用"，不如让它根本不知道。

提示词里已有通则：**参数缺关键信息时不要调用，在 reply 里问清楚**。写 `when` 字段时可以借这条。

### 现有插件

`timeblock`（作息）、`pomodoro`（专注）、`habit`（打卡）、`achievement`（成就）、`notebook`（记事本）。

---

## 数据层

`src/main/db.ts` 只是 re-export 门面，实现按领域拆在 `src/main/db/` 下。**新增数据函数加到对应领域模块，不要写在门面里。**

`src/main/db/connection.ts` 是唯一持有 Database 句柄的地方，其余模块用 `getDb()` 取，不各自开库。

`getSettings()` 带缓存（它在每条活动事件、每轮屏幕监控里都会被调好几次），只在 `saveSettings()` 里失效。
所以 **AppSettings 的键只能经 `saveSettings()` 写**，别直接往 settings 表里写；返回值是共享快照，**不要原地修改**。
插件状态（`plugin:*`）和活动对照行（`activityTimelineComparison:*`）不在 AppSettings 里，不受影响。

### 核心表

`profile` `settings` `sources` `tasks` `detections` `work_records` `app_usage` `reports` `chat_messages` `personal_memory` `focus_tasks` `detection_notes` `app_switches` `app_categories` `activity_segments` `ocr_evidence` `voice_sessions` `voice_segments`

插件表另在各自 `initTables` 里建，前缀 `p_<id>_`。

### 迁移方式

**SQLite 不能改主键、不能删列。** 建表用 `CREATE TABLE IF NOT EXISTS`，加列走增量迁移：

```ts
const cols = (db.prepare('PRAGMA table_info(表名)').all() as { name: string }[]).map(c => c.name)
if (!cols.includes('新列')) db.exec('ALTER TABLE 表名 ADD COLUMN 新列 ... DEFAULT ...')
```

**默认值要让旧行的行为和升级前完全一致。** 需要改主键时只能 drop 重建（见 `connection.ts` 的 `dropLegacyChatTable`）。

跨版本的大迁移在 `src/main/db-migrations.ts`。

### 对话历史

`chat_messages` 按 `scope` 分开存：`'assistant'`（桌宠 / 悬浮助手）和 `'quickbar'`（快捷提问框）。整表覆盖式写入，上限 200 条。见 `src/main/db/chat.ts`。

---

## 主进程关键模块

### 入口与窗口

- `index.ts` — `app.whenReady()` 里的启动顺序：`initDb()` → `installAppMenu()` → `registerIpc()` → 各子系统 → 托盘菜单 → 快捷键
- `windows.ts` — 窗口管理；`broadcast()` 广播事件到所有窗口，`broadcastExcept(senderId, …)` 跳过发起者（避免自己写的东西回弹）
- `app-menu.ts` — macOS 应用菜单。**没有它连输入框的 ⌘C/⌘V 都不工作**

### 独立窗口

各自是无边框置顶小窗，加载渲染层的 hash 路由：

| 窗口 | 主进程 | hash |
|---|---|---|
| 快捷提问框 | `quickbar.ts` | `#/quickbar` |
| 桌宠 | `pet/pet-window.ts` | — |
| 桌宠对话框 | `pet/pet-chat-window.ts` | `#/petchat` |
| 提醒卡 | `reminder-window.ts` | `#/reminder` |
| 预览卡 | — | `#/preview` |
| 调试 | — | `#/debug` |

**主进程往窗口推消息一律走 `whenWindowReady(win, …)`**（`main/window-ready.ts`）：渲染层在 effect 里挂好订阅后调
`api.windowReady()`，主进程把在那之前的消息排队、就绪后按序补发。直接 `webContents.send` 会在窗口刚建、
订阅还没挂上时把消息丢掉。新增一个接收推送的窗口时，渲染层要在订阅 effect **之后**加一行 `useEffect(() => { void api.windowReady() }, [])`。

有了握手，窗口不必为了不丢消息而常驻：提醒卡到点才建、处理完就关；预览卡隐藏后空闲 2 分钟关窗。
快捷提问条和桌宠对话框仍然启动时预建——它们由快捷键/点击唤起，要求秒开。

### 捕获与解析

- `capture.ts` — 捕获入口
- `clipwatch.ts` — 剪贴板自动捕获
- `screenwatch.ts` — 屏幕感知主线（截图 → OCR → 云端解析的门控与编排）
- `detection-cards.ts` — 候选 → 记忆历史 → 弹卡 → 入库的共用内核
- `task-ingest.ts` — **ParsedItem → 任务落库的统一映射**。capture / assistant / detection-cards 三条接受流共用，新增任务字段只改这一处
- `parser.ts` — 解析。直连时按 `settings.apiFormat` 走三套协议之一，翻译层在 `shared/api-formats.ts`
- `detection-gate.ts`（shared）— 屏幕感知候选的**入队门槛**与「完成即撤」。模型给的
  `confidence` / `suggested_action` 在这里被采纳；没过门槛的存成 `archived`，
  留痕参与去重但不进用户的待确认队列（issue #128）
- `privacy.ts` — 上云前的隐私门（本应用识别、排除名单、私密浏览、安全输入）
- `ocr.ts`、`shotvault.ts`、`phash.ts` — OCR 与截图留存

### 语音纪要

`voicenotes/` 三个文件：`service.ts` 会话生命周期与会议应用自动触发、
`transcribe.ts` OpenAI 兼容的 `/v1/audio/transcriptions` 客户端、`parse.ts` 转录文本 → 任务。

**录音在渲染层**（`renderer/src/voice-capture.ts`，只有那里拿得到 `getUserMedia`），
主进程只判定「何时该录」、收分段、调转录、落任务。判定逻辑在 `shared/voicenotes.ts`：
会议应用识别、按停顿切段（不按固定时钟窗口）、WAV 封装，都是纯函数。

解析时会注入用户档案 + 最近三天的工作记录——会上说的话十有八九不是给用户的，
没有这两块上下文，模型判不出「这活是谁的」。会议来的任务一律走待确认。

macOS 需要 `NSMicrophoneUsageDescription`（`electron-builder.yml`），
缺这条系统会在首次 `getUserMedia` 时直接终止进程，而不是弹授权框。

### 助手对话

`assistant.ts` — `assistantChat()` 是主流程，`assistantAdd()` 落库，`notifyQuickChatResult()` 把后台完成的结果交给桌宠播报。

提示词构造在 `shared/parsing.ts` 的 `buildAssistantInstructions()`。

### History v2（屏幕活动）

`src/main/history/` 一整套：`service.ts`（生命周期）、`event-store.ts`、`summarizer.ts`、`query-service.ts`、`work-derivation.ts`、`retention.ts`。

事件采集由 `activity-tracker.ts` 负责，`history/` 只管存储与派生。

**活动时间线（`activity_intervals`，保留 90 天）是唯一的计时来源**：应用时长、应用切换、工作记录都从它派生。
- 应用时长：90 天内直接从区间现算；`app_usage` 只是采样器从区间投影出的按天汇总，过了保留期才被读取
- 应用切换：由相邻的活跃区间推出（没有单独的切换表）
- 工作记录：**只由 10 分钟摘要按区间派生**（`derived_by = 'timeline'`，`history/service.ts` 的 `onTenMinuteSummary`），
  区间里没被摘要覆盖的空档显示成「使用 X，暂无活动描述」。屏幕 OCR 只用来找待办，不再顺带写工作记录

以前的「原计时 / 后台对照 / 统一计时」三种模式、旧 OCR 工作记录、Accessibility 语义归类和几个隐藏回滚开关都已删除（产品未上线，没有存量数据）。

### 对外 MCP 服务

`mcp-server.ts` — 把任务/工作记录/日报暴露成 MCP 工具，供用户在 Claude Desktop、Cursor 里操控谷子。**方向是向外的，跟应用内助手能做什么无关**（后者由 `assistantActions` 决定）。只绑 127.0.0.1 + Bearer token。

### 调度器

`report-scheduler.ts`（日报）、`dailybrief-scheduler.ts`（每日简报）、`task-reminder.ts`（任务提醒，30 秒 tick；事件前按提前量提醒，只给了日期的截止——无开始时刻、截止 23:59——锚在当天 09:00，截止前开机都会补）、`wellness-reminder.ts`、`usage-sampler.ts`（前台应用采样）。

---

## 渲染层

### 路由

`App.tsx` 只做路由：先看 hash 决定是不是独立窗口（`/preview` `/reminder` `/debug` `/petchat` `/quickbar`），否则按需加载主界面 `MainApp.tsx`。**小窗组件必须保持同步 import**——主进程在 `did-finish-load` 后立刻推第一条消息，组件若还在等分块就会丢消息；主界面整套（页面、插件、Supabase 客户端、录音）只在主窗口里求值。

主导航：**今日 / 日程 / 日报 / 分析 / 个人**（`MainApp.tsx` 的 `NAV`）。设置和市场固定在侧边栏底部，不在主导航里。插件页由 `PLUGIN_UI[page]?.Page` 渲染。

页面跳转统一走 `MainApp.tsx` 的 `navigate(page, cat?)`，第二个参数只对设置页有意义
（深链到某个分区，如首页「去设置开启」直接落到屏幕感知）。每次导航都重设，
所以从侧栏进设置不会残留上一次的分区。

### 关键文件

- `api.ts` — 渲染层调主进程的统一入口，含 `api.plugin()`
- `components/ui.tsx` — 共用控件：`Toggle` `Section` `Segmented` `DayNav` `BarRow`
- `components/Modal.tsx` — 弹窗，用法 `<Modal panelClass onClose>{(close) => …}</Modal>`
- `components/AssistantChat.tsx` — 聊天组件，桌宠对话框和悬浮助手共用
- `textarea.ts` — `autoGrow()` 按 scrollHeight 自适应高度、`insertNewline()` 在光标处插换行
- `labels.ts` — 文案与格式化，以及引导页/个人页的 Tab 补全（`fillFromPlaceholder`）
- `voice-capture.ts` — 麦克风采集：16kHz 单声道 PCM + 能量 VAD 按停顿切段
- `components/settings/` — 设置分区各一个文件；分区清单在 `pages/Settings.tsx` 的 `CATS`

---

## 测试

```bash
npm run test              # 全部默认用例（无需 API，CI 用这个）
node test/run.mjs history # 只跑文件名含 history 的
node test/run.mjs --all   # 连需要 .env/API 的一起跑
node test/run.mjs --verbose
npm run test:scenarios    # 日常场景端到端（离线回放）；加 -- --run --config <chmod 600 的 JSON> 打真实模型
```

`test/run.mjs` 自动发现 `test/*-smoke.mjs`，**新增用例不用改 package.json**。测试直接 import `.ts` 源码。

### ⚠️ 本地必挂的两个用例

`history-delete-smoke.mjs` 和 `history-migration-smoke.mjs` 在本地报 `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION 139 vs 141`。

**这是环境差异，不是代码坏了**：本地 `better-sqlite3` 是为 Electron ABI(139) 编译的，而 `node` 是 141。CI 里有一步 `npm rebuild better-sqlite3` 把它重编成 Node ABI，所以是绿的。**本地看到这两个失败，直接忽略，不要去"修"。**

### shared 模块互相 import 的写法

值导入**必须带 `.ts` 扩展名**（测试直接跑源码，走 Node 的 ESM 解析）：

```ts
import { foo } from './work-report.ts'      // 值导入：带 .ts
import type { Bar } from './types'          // 纯类型：可以不带（编译期擦除）
```

---

## CI

`.github/workflows/ci.yml`，单个 job「Typecheck & Build」：
`npm ci` → **`npm rebuild better-sqlite3`** → `npm run typecheck` → `npm run test:unit` → `npm run build`。

---

## 构建与发布

```bash
npm run dev        # 开发
npm run build      # 只编译，产物到 out/
npm run pack:dir   # 打出 .app（本地安装够用，快）
npm run pack:mac   # 打 DMG + ZIP（发版用）
```

产物在 `release/`，`out/` 和 `release/` 都已 gitignore。

### ⚠️ 在 git worktree 里打包会失败

worktree 没有自己的 `node_modules`（vite/tsc 靠向上查找用主仓库的），但 electron-builder 要从项目自身的 `node_modules` 读 electron 的确切版本，只看到 `package.json` 里的 `^38.2.0` 范围就报错：

```
Electron version "^38.2.0" is a range, not a fixed version
```

绕过办法是命令行覆盖，不用改仓库配置：

```bash
npm run build
npx electron-builder --mac --dir -c.electronVersion=<主仓库 node_modules/electron 的实际版本>
```

### 本地替换安装

```bash
osascript -e 'tell application "谷子助手" to quit'
mv "/Applications/谷子助手.app" ~/.Trash/谷子助手-旧版.app   # 留个退路
cp -R release/mac-arm64/谷子助手.app /Applications/
xattr -dr com.apple.quarantine /Applications/谷子助手.app
open -a /Applications/谷子助手.app
```

用户数据在 `~/Library/Application Support/GuziAssistant/`（库文件是 `eshell.db`），**不在 app 包里，替换不影响**。

验证新代码进包了（asar 是二进制容器，`grep -a` 对中文会失效，用 node）：

```bash
node -e "const b=require('fs').readFileSync('/Applications/谷子助手.app/Contents/Resources/app.asar');
console.log(b.includes(Buffer.from('某个新加的中文串','utf8')))"
```

### 发版流程

1. `package.json` 和 `package-lock.json` 版本号一起改（**lockfile 容易漏**）
2. 提交 → 推分支 → `gh pr create` → 等 CI → `gh pr merge`
3. 在 `main` 的合并提交上打 `vX.Y.Z` 标签并推送 → `macos-release.yml` 自动构建隔离测试草稿
4. 测试草稿通过后手动触发同一工作流：`publish=true`、`confirmation=publish-vX.Y.Z` → 正式版发到本仓库 Releases，Sparkle 更新源随之指向新版（macOS 应用内更新的唯一数据源）
5. 细节与一次性的旧仓库桥接（`bridge_legacy`）见 CONTRIBUTING.md「发布」。`scripts/publish-release.sh` 是旧的 Supabase Storage 渠道，只剩 Windows 检查更新在读，托管后端暂停期间不要用

---

## 约定与陷阱

### 代码风格

- 注释只写 **WHY**，不复述命名已经表达的 WHAT。这个仓库的文件头注释质量很高，**摸不清一个模块时先读它的头注释**，通常直接说清了设计取舍
- 不过度防御：不可能发生的 error handling、用不到的 fallback、为"未来扩展"的抽象都不加
- 三行相似好过过早抽象，有第四次再重构

### 具体的坑

- **`window.prompt` 在 Electron 里不可用**，要用内联输入框。`window.confirm` 可用，是本项目既有约定
- **`<input type="time">` 不接受 `24:00`**，而 `minutesToLabel(1440)` 正是输出 `24:00` 表示"到当天结束"。涉及时间块的编辑要用文本框 + `labelToMinutes` 校验
- **textarea 高度不能按 `'\n'` 个数算**，长文本软折行时行数仍是 1，框子不会长高。用 `autoGrow()` 读 `scrollHeight`
- **`⌘⏎` 在 textarea 里不会自己插换行**（只有 `⇧⏎` 会），必须手动插；插完 React 重渲染会把光标甩到末尾，要在下一帧放回去
- **body 全局禁用了文字选择**，需要选中的区域要显式 `select-text` / `user-select: text`
- **嵌套的 drop 区域不要 `stopPropagation`**，否则 `MainApp.tsx` 的 `handleDrop` 收不到，拖放遮罩会卡住不消失
- **CSP 是 `img-src 'self' data:`**，图片要以 data URL 回读
- **`h-full` 在 `MainApp.tsx` 的 `animate-page` 容器里解析成 `auto`**（那个 div 是块级、高度由内容撑）。需要满高的插件页用 `h-screen`，不要改共用容器——会影响所有核心页的滚动
- **contentEditable 里新起的行常常是 `<div>` 而不是 `<p>`**（Chromium 的 `defaultParagraphSeparator` 就是 div）。记事本的 `currentBlock()` 曾因白名单漏了 DIV，导致 slash 菜单、Markdown 输入规则、公式块级渲染在新打的行上**一起静默失效**——载入时的渲染照常工作，所以症状像「有时行有时不行」。凡是靠标签白名单找块的地方都要留兜底
- **contentEditable 里空的块元素不是合法落点**，浏览器会把光标弹到上一行。新建空块必须塞一个 `<br>`；而落光标时「内容末尾」等于落在 `<br>` 之后（又跑下一行），空块要显式落块首
- **中文输入法激活时 `keydown` 上报的 `key` 不可靠**（常见 `Process` / keyCode 229）。要判具体字符的输入规则挂 `beforeinput`，按 `inputType === 'insertText' && data === '…'` 判断，组合输入期间是 `insertCompositionText`，天然不会误命中

### 中文日期 / 节假日

`src/shared/holidays.ts` 是**手工维护**的法定节假日与调休补班表，来源是国务院办公厅每年的通知。**调休推不出来**（国庆前的周日要补班、春节当中的周三是假期），只能逐日录入。未收录的年份自动退回自然周判定，**不要外推、不要凭记忆编**——新一年的安排通常在前一年 11 月发布。

---

## 想改 X，去哪

| 要改的东西 | 落点 |
|---|---|
| 新增 IPC 通道 | `shared/ipc-channels.ts` 登记 → `main/ipc/<领域>.ts` 注册 → `renderer/src/api.ts` 调用 |
| 主进程往窗口推消息 | `whenWindowReady(win, () => win.webContents.send(…))`，渲染层订阅后 `api.windowReady()` |
| 新增插件 | `shared/plugin-registry.ts` + `main/plugins/<id>/` + `renderer/src/plugins/<id>/`，注册进两个 index |
| 插件加一个后端能力 | 该插件 `index.ts` 的 `handlers` 加 key，自动注册 |
| 让助手会做新动作 | 插件 manifest 的 `assistantActions` + 主进程模块的 `assistantActions` 实现 |
| 加数据库字段 | 对应 `db/*.ts` 的 `initTables` 走增量迁移；插件表在插件自己的 `initTables` |
| 改任务字段映射 | `main/task-ingest.ts` 一处（三条接受流共用） |
| 改助手提示词 | `shared/parsing.ts` 的 `buildAssistantInstructions()` |
| 改主界面导航 | `renderer/src/MainApp.tsx` 的 `NAV` |
| 改聊天输入行为 | `components/AssistantChat.tsx`（桌宠+悬浮助手）和 `pages/QuickBar.tsx`（快捷提问，**是另一份代码**） |
| 加共用控件 | `renderer/src/components/ui.tsx` |
| 加纯逻辑 + 单测 | `shared/xxx.ts` + `test/xxx-smoke.mjs`（自动发现，不用改 package.json） |

---

## 小建议

这个文件叫 `claude readme.md`，每次要手动让 AI 去读。如果改名成仓库根目录的 `CLAUDE.md`，Claude Code 会**每次会话自动加载**，就不用每次交代了。内容不用动，只改文件名。
