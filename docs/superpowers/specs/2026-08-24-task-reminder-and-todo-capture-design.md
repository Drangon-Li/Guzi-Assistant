# 任务提醒 + 清单自动识别恢复

> 设计文档（spec）。面向实施。日期 2026-08-24。
> 解决两个用户报告的问题：① 任务到点没有任何提醒；② hybrid v2 上线后屏幕感知的待办抓取被结构性绕过，只剩历史记录分析。

## 1. 背景与根因

### 1.1 问题一：任务提醒根本没有实现

`tasks` 表有 `start_time` / `due_time`（`src/main/db.ts:65-66`），但全项目**没有任何按任务时间触发的调度器**。现存三个定时器都不是任务提醒：

| 文件 | 作用 |
|---|---|
| `src/main/dailybrief-scheduler.ts` | 每天 08:30 一条汇总系统通知（会自动消失） |
| `src/main/report-scheduler.ts` | 按 `dailyReportTime` 生成日报 |
| `src/main/wellness-reminder.ts` | 连续活跃 50 分钟 → 桌宠气泡「走动一下吧～」 |

所以到点什么都不会发生。这不是「提醒不够明显」，是功能缺失。

### 1.2 问题二：待办抓取被 hybrid v2 截断

两处叠加导致 `detectAll`（唯一的待办抽取入口）在正常情况下永不执行：

1. **`src/shared/hybrid-history.ts` 的 `decideOcrTrigger`**：语义完整时直接 `{ run: false, reason: 'complete' }`。而 `screenSenseHybridV2` 默认开（`src/main/db.ts:322`），`assessSemanticCompleteness` 里「有 App/bundle（30）+ 有窗口标题（40）」即达 70 分判为 `complete`。只要 Accessibility 正常，就**不截图、不 OCR、不上云 → `detectAll` 不执行 → 任务永远识别不出来**（`src/main/screenwatch.ts:872-889`）。`partial` 且无高价值事件时同样返回不跑。
2. **`src/shared/semantic-work.ts:86` 的 `buildSemanticWorkHint`**：走 AX 语义路径时，返回格式被硬写成 `{"items":[], "activities":[...]}` —— `items` 恒为空数组，只要 `work_summary` 和 `focus_task`。

结果：屏幕感知实际只剩「历史记录分析 / 工作记录」，待办抓取只在 AX 失效降级时才偶发触发。

### 1.3 目标

- **A**：任务到点（及可配的提前量）有**明确、不点不消失**的提醒，且提醒强度不因某个开关被关而归零。
- **B1**：恢复屏幕感知的待办抓取，同时保住 hybrid v2 的省电/省积分收益。
- **B2**：一屏/一段文字里有多条待办时，整份清单逐条拆出并**批量确认入库**，而不是逐张弹 N 次卡。

### 1.4 非目标

- 不改捕获来源链路（剪贴板/拖拽/飞书/访达右键走 `capture.ts` 老路，本次只补 prompt）。
- 不做重复性任务（每周/每天循环）的提醒——本次只提醒单次事件时刻。
- 不改 History v2 的原生采集、segment 存储与摘要派生。
- 不做提醒声音/自定义铃声。

## 2. 决策摘要（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 提醒形式 | 置顶提醒卡窗 + 桌宠常驻气泡 + 系统通知，**三重** |
| 提醒时机 | 到点 + 可配提前量（全局默认 5 分钟），**任务级可覆盖** |
| 待办识别修复方向 | 给待办识别**独立的 OCR 触发通道**，不放开 AX 路径的 `items` |
| 清单识别口径 | **两者都做**：恢复屏幕感知抓取 + 整份清单批量拆解入库 |
| `pending`（待确认）任务 | **不提醒**——用户还没认下这件事 |
| 事件时刻口径 | `startTime ?? dueTime`（与 `daily-brief` 的 `dueTime ?? startTime` 相反：提醒要赶在「开始」之前） |
| 只有日期无时分的任务 | 按当天 **09:00** 提醒 |
| 逾期补提醒 | 补，但**只补 2 小时内**的（防关机数日后开机弹一屏） |
| 提醒卡窗 | **新建独立窗口**，不复用 preview 窗 |
| 提醒卡位置 | 屏幕**右上角**（避开右下角的桌宠 + 检测卡） |
| 提醒气泡与「气泡提醒」总开关 | **遵守**该开关；卡窗与系统通知不受影响，强度不归零 |
| 批量清单卡的自动忽略倒计时 | **不倒计时**（多条内容 5 秒读不完） |
| 现有逐张卡队列 | **移除**，由批量卡取代 |

### 2.1 为什么提醒卡不复用 preview 窗

两个理由都是硬约束：

1. `isPreviewVisible()` 被持续监控当作门控用（`src/main/screenwatch.ts:792`）——卡开着就暂停屏幕感知。提醒卡不点不消失，挂几小时会把感知停死。
2. 检测卡带 `screenSenseCardHideSec` 倒计时自动忽略。提醒卡绝不能自动消失。

## 3. Part A：任务提醒子系统

### 3.1 判定纯函数 `src/shared/task-reminder.ts`（新建）

按 `daily-brief.ts` 的模式：纯函数 + 注入 `now`，可单测。

```ts
export interface ReminderTask {
  id: string
  title: string
  startTime: string | null
  dueTime: string | null
  status: TaskStatus
  belongsToUser: Belongs
  priority: Priority
  /** null = 跟随全局默认；-1 = 该任务关闭提醒 */
  remindOffsetMin: number | null
  /** 已提醒过的目标时刻（本地 ISO），幂等键 */
  remindedAt: string | null
  /** 稍后提醒到的时刻（本地 ISO） */
  snoozedUntil: string | null
}

export interface DueReminder {
  taskId: string
  /** 本次提醒的目标时刻，触发后写回 reminded_at 做幂等 */
  targetIso: string
  /** 事件真正发生的时刻，供卡片文案 */
  eventIso: string
  kind: 'ahead' | 'ontime' | 'catchup' | 'snooze'
}

export interface ReminderOptions {
  enabled: boolean
  defaultOffsetMin: number
  catchupWindowMin: number
}

export function dueReminders(
  tasks: ReminderTask[],
  opts: ReminderOptions,
  now: Date
): DueReminder[]
```

判定顺序（逐任务）：

1. `opts.enabled === false` → 整体返回 `[]`。
2. `belongsToUser !== 'yes'` → 跳过。
3. `status ∉ {not_started, scheduled, in_progress, overdue}` → 跳过（`pending` / `done` / `ignored` 都不提醒）。
4. `remindOffsetMin === -1` → 跳过（该任务显式关闭提醒）。
5. **snooze 优先**：`snoozedUntil` 非空时
   - `remindedAt === snoozedUntil` → 跳过（这次稍后已兑现，且事件时刻没变过）；
   - `snoozedUntil > now` → 跳过（还在稍后窗口内）；
   - 否则 `targetIso = snoozedUntil`，`kind = 'snooze'`，**不受 catchup 窗口限制**（用户自己按的稍后，必须兑现）。

   > 第一条不能省。若省掉，snooze 兑现后 `remindedAt` 记的是 `snoozedUntil`，与常规 `targetIso`（事件时刻减提前量，已在过去）不相等，下一 tick 会立刻再提醒一次。
6. 否则计算常规目标时刻：
   - `eventIso = startTime ?? dueTime`；两者皆空 → 跳过。
   - `eventIso` 长度为 10（只有日期）→ 视作 `${eventIso}T09:00`。
   - `offset = remindOffsetMin ?? opts.defaultOffsetMin`（clamp 到 0..1440）。
   - `targetMs = eventMs - offset * 60_000`。
7. **幂等**：`remindedAt === targetIso` → 跳过。改了任务时间 / 提前量 → `targetIso` 变化 → 会重新提醒一次（这是想要的行为）。
8. `targetMs > now` → 跳过（还没到）。
9. `now - targetMs > opts.catchupWindowMin * 60_000` → 跳过（太久之前，不补；用户去日程页看即可）。
10. `kind`：`now < eventMs - 60_000` → `'ahead'`；`|now - eventMs| <= 60_000` → `'ontime'`；否则 `'catchup'`。

排序：按 `eventMs` 升序，同刻按 `priority`（high/medium/low/unknown）。

**上限**：函数返回全部命中项；截断由调用方做（见 3.2），便于测试断言完整结果。

### 3.2 调度器 `src/main/task-reminder.ts`（新建）

不给每个任务开 `setTimeout`——长 timer 在睡眠 / 时钟跳变后不可靠。改 30 秒 tick：

```
TICK_MS = 30_000
MAX_CARDS_PER_TICK = 5
CATCHUP_WINDOW_MIN = 120

startTaskReminder()  // 建 interval + 注册 powerMonitor 'resume'，首跑延迟 5s（等窗口就绪）
stopTaskReminder()
applyTaskReminderSchedule()  // 跟随 taskReminderEnabled 设置启停

tick():
  s = getSettings()
  if (!s.taskReminderEnabled) return
  due = dueReminders(listReminderCandidates(), {
    enabled: true,
    defaultOffsetMin: s.taskReminderOffsetMin,
    catchupWindowMin: CATCHUP_WINDOW_MIN
  }, new Date())
  if (!due.length) return
  // 先写幂等再展示：即使展示失败也不会下一 tick 又刷一遍
  for (d of due) markTaskReminded(d.taskId, d.targetIso)
  shown = due.slice(0, MAX_CARDS_PER_TICK)
  overflow = due.length - shown.length
  showReminders(shown.map(toCardItem), overflow)
```

推给渲染层的载荷（`guzi-assistant:reminder` 事件）：

```ts
interface ReminderCardItem {
  taskId: string
  title: string
  eventIso: string
  kind: 'ahead' | 'ontime' | 'catchup' | 'snooze'
  location: string | null
  notes: string[]
  priority: Priority
}
interface ReminderPayload { items: ReminderCardItem[]; overflow: number }
```

30 秒精度对提醒足够，且天然抗休眠 / 时钟跳变。`powerMonitor.on('resume')` 立即补跑一次 tick，覆盖合盖唤醒场景。

**为什么先写 `reminded_at` 再展示**：反过来的话，展示链路任意一环抛错都会导致下一 tick 重新命中同一条，变成 30 秒刷一次屏。代价是极端情况下丢一次提醒——比刷屏可接受。

### 3.3 数据模型变更

**`src/main/db-migrations.ts` 新增 `migrateTaskReminders(database)`**，照 `migrateWorkRecords` 的加列模式（纯 additive，旧版本客户端仍能读）：

```sql
ALTER TABLE tasks ADD COLUMN remind_offset_min INTEGER;   -- NULL=跟随全局，-1=不提醒
ALTER TABLE tasks ADD COLUMN reminded_at TEXT;
ALTER TABLE tasks ADD COLUMN snoozed_until TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(belongs_to_user, status);
```

调用点：`src/main/db.ts:186` 附近，紧跟 `migrateWorkRecords(db)`。

**`src/shared/types.ts` 的 `TaskRecord`** 加三个字段：`remindOffsetMin: number | null`、`remindedAt: string | null`、`snoozedUntil: string | null`。

**`src/main/db.ts`** 相应改动：
- `TaskRow` 加三列；`rowToTask`（`db.ts:551`）映射；`createTask` 的 INSERT 补默认值（全 NULL）。
- `TASK_EDITABLE`（`db.ts:642`）加 `remindOffsetMin: 'remind_offset_min'`，让用户能在任务详情里改提前量。**不**把 `remindedAt` / `snoozedUntil` 放进 `TASK_EDITABLE`——它们只由提醒子系统写，走专用函数。
- 新增三个函数：
  - `listReminderCandidates(): ReminderTask[]` —— 窄查询，只取 `belongs_to_user='yes' AND status IN (...) AND (start_time IS NOT NULL OR due_time IS NOT NULL)`，不调 `markOverdue()`（保持 tick 廉价；overdue 仍在允许状态集内，不影响判定）。
  - `markTaskReminded(id: string, targetIso: string): void` —— 只写 `reminded_at`。**不清 `snoozed_until`**：snooze 的幂等靠 `remindedAt === snoozedUntil` 判定（见 3.1 规则 5）。
  - `setTaskSnooze(id: string, untilIso: string): void` —— 写 `snoozed_until`。用户在稍后卡上再次点稍后时覆盖为更晚的时刻，`remindedAt` 自然不再等于它，下一轮会正常兑现。

- **`updateTask` 增加提醒状态复位**：当 patch 里 `startTime` / `dueTime` / `remindOffsetMin` 的值**实际发生变化**时，同一条 UPDATE 里把 `reminded_at` 和 `snoozed_until` 置 NULL。这是「改了任务时间就重新提醒」的落地方式，也避免旧的 `snoozed_until` 让新时刻永远不提醒。实现位置：`db.ts:661` 的 `updateTask` 内，与已有的 overdue 复位逻辑并列。

**`src/shared/types.ts` 的 `AppSettings`** 加：

| 字段 | 默认 | 读取写法（`db.ts:getSettings`） |
|---|---|---|
| `taskReminderEnabled: boolean` | `true` | `map.taskReminderEnabled !== 'false'` |
| `taskReminderOffsetMin: number` | `5` | `map.taskReminderOffsetMin != null ? clamp(0, 1440, Number(...)) : 5` |

### 3.4 提醒呈现（三重）

#### ① 置顶提醒卡窗

**`src/main/reminder-window.ts`（新建）**，窗口属性照 `windows.ts:getPreviewWindow` 那套：

```
width: 360, height: 280
frame: false, transparent: true, resizable: false
alwaysOnTop: true → setAlwaysOnTop(true, 'screen-saver')
setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
skipTaskbar: true, hasShadow: false, show: false
webPreferences: { preload, backgroundThrottling: false }
load(win, '/reminder')
showInactive()   // 不抢焦点
```

定位：取**光标所在显示器**（`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`）的 `workArea`，放 `workArea.x + workArea.width - 376`, `workArea.y + 16`。多显示器下提醒出现在用户正在看的那块屏上——用主显示器会让提醒弹到用户背后。

导出：`showReminders(items, overflow)` / `hideReminderWindow()` / `isReminderVisible()`。

**卡片内容**（`src/renderer/src/pages/ReminderCard.tsx` 新建，路由 `/reminder` 挂进 `App.tsx`）：

- 顶部：队列指示 `1/3`（多条时）、任务标题。
- 时间状态文案按 `kind`：`ahead` → 「10 分钟后 · 14:30」；`ontime` → 「现在 · 14:30」；`catchup` → 「已逾期 2 小时」；`snooze` → 「稍后提醒 · 14:30」。
- 地点、注意事项（`notes`）。
- 按钮：**完成** / **稍后（5 / 15 / 60 分钟）** / **知道了** / **打开日程**。
- `overflow > 0` 时底部一行「另有 N 件到点，去日程页查看」。
- **无倒计时进度条，无自动关闭。** 队列在渲染层维护：主进程一次推一批，渲染层自己走 1/N，最后一张处理完调 `reminder:close`。

#### ② 桌宠常驻气泡

`src/main/pet/controller.ts` 现有 `applyExternalPetSay` 必带超时清除（`sayTimer` + `sayToken`），需要新增两个导出：

```ts
export function applyPetPersistentSay(message: string, reaction?: PetReaction): void
export function clearPetPersistentSay(): void
```

优先级规则（这是本次最容易出 bug 的地方，单独测）：

| 场景 | 行为 |
|---|---|
| `applyPetPersistentSay` 时 `quiet()` 或 `bubbles` 关 | 直接 return（遵守「气泡提醒」总开关） |
| 生效时 | 清 `sayTimer`、`sayToken++`、`processingBubble = false`、`persistentSay = true`、`setPetBubble(message, reaction)` |
| `applyExternalPetSay` 在 `persistentSay` 期间被调 | **直接 return**（普通气泡不顶掉提醒气泡） |
| `setPetScanning(on)` 在 `persistentSay` 期间 | 只切光环，**不动气泡** |
| `setPetListening(on)` 在 `persistentSay` 期间 | **允许覆盖**（用户主动按住，当下优先级最高）；`off` 时若提醒卡仍可见，**重放**提醒气泡 |
| `clearPetPersistentSay()` | `persistentSay = false; setPetBubble(null)`；由提醒卡窗隐藏时调 |

#### ③ 系统通知

`new Notification({ title: '谷子助手 · 任务提醒', body })`，`n.on('click', () => focusMain('schedule'))`。macOS 通知本身会自动消失——它是兜底：应用被隐藏、在另一个 Space、或桌宠被用户关掉时仍能感知到。

多条时只发一条汇总通知（`「XX」等 N 件事到点了`），避免通知中心刷屏。

### 3.5 IPC 与 UI

**`src/shared/ipc-channels.ts`** 新增（不登记则 preload 白名单拒绝，且 `test/ipc-channels-smoke.mjs` 会挂）：

INVOKE：`reminder:done`、`reminder:snooze`、`reminder:dismiss`、`reminder:close`、`reminder:open-schedule`
EVENT：`guzi-assistant:reminder`

**`src/main/ipc.ts`** 注册：

| 通道 | 行为 |
|---|---|
| `reminder:done(taskId)` | `updateTask(id, { status: 'done' })` + `broadcast('guzi-assistant:tasks-updated')` |
| `reminder:snooze(taskId, minutes)` | `setTaskSnooze(id, isoOf(now + minutes))` |
| `reminder:dismiss(taskId)` | no-op（`reminded_at` 已在触发时写入，不会重复） |
| `reminder:close()` | `hideReminderWindow()` + `clearPetPersistentSay()` |
| `reminder:open-schedule()` | `focusMain('schedule')` + 同 `reminder:close` |

**`src/renderer/src/api.ts`** 加对应薄封装。

**`Settings.tsx`** 新增「任务提醒」一节（放在「屏幕感知」之前）：总开关 Toggle（`taskReminderEnabled`）+ 默认提前量下拉（0 / 5 / 10 / 15 / 30 / 60 分钟）。

**`TaskDetailModal.tsx` / `EditTaskModal.tsx`** 加「提醒」字段：跟随默认 / 提前 N 分钟 / 不提醒，写 `remindOffsetMin`（`null` / 正整数 / `-1`）。

**`src/main/index.ts`** 启动时 `startTaskReminder()`，退出时 `stopTaskReminder()`（照 `startWellnessReminder` 在 `index.ts:179/196` 的挂载方式）；`saveSettings` 后调 `applyTaskReminderSchedule()`。

## 4. Part B：清单自动识别

### 4.1 B1 — 待办识别的独立触发通道

不新开一条并行截图路径（那会变成两条链路各自截图、各自计费）。改为给 `decideOcrTrigger` 加一个在 `complete` 短路**之前**判定的分支。

**`src/shared/hybrid-history.ts`**：

- `OcrTriggerReason` 加 `'todo_scan'`。
- `OcrTriggerInput` 加 `todoScanDue?: boolean`。
- 在 `if (input.semantic.semanticLevel === 'complete')` **之前**、全局 cooldown 检查**之后**插入：
  ```ts
  if (input.todoScanDue) return { run: true, reason: 'todo_scan' }
  ```

判定链变成：

```
manual → hybrid 关（legacy）→ privacy → active → screenAllowed → observer 限流 → 全局 cooldown
  → todo_scan due？ → run: true, reason: 'todo_scan'      ← 新增
  → semantic complete → run: false                        ← 原逻辑不变
  → observer_failure / partial 矩阵 / hard_fallback        ← 原逻辑不变
```

放在全局 cooldown（默认 45s）之后不会冲突：todo-scan 间隔默认 180s，远大于 45s。

**`src/shared/todo-scan.ts`（新建）**：

```ts
export type TodoScanAppKind = 'im' | 'mail' | 'browser' | 'docs' | 'calendar' | null

/** bundleId 优先精确匹配，App 名兜底做包含匹配。 */
export function todoScanAppKind(appName: string | null, bundleId: string | null): TodoScanAppKind

export function shouldTodoScan(input: {
  enabled: boolean
  appKind: TodoScanAppKind
  nowMs: number
  lastTodoScanAtMs: number | null
  intervalSec: number
}): boolean
```

词典（按 `work-report.ts` 里 `categoryOf` 的写法组织；现有 `app-categories` 那套只分 productive/neutral/distracting，口径不同，不复用）：

| kind | bundleId | App 名兜底 |
|---|---|---|
| `im` | `com.tencent.xinWeChat`、`com.tencent.qq`、`com.electron.lark`、`com.alibaba.DingTalk`、`com.tinyspeck.slackmacgap`、`com.hnc.Discord`、`ru.keepcoder.Telegram` | 微信、QQ、飞书、钉钉、Slack、Discord、Telegram |
| `mail` | `com.apple.mail`、`com.microsoft.Outlook`、`com.readdle.smartemail-Mac` | 邮件、Mail、Outlook、Spark |
| `browser` | `com.apple.Safari`、`com.google.Chrome`、`com.microsoft.edgemac`、`company.thebrowser.Browser` | Safari、Chrome、Edge、Arc |
| `docs` | `notion.id`、`com.yuque.app`、`md.obsidian`、`com.apple.Notes` | Notion、语雀、Obsidian、备忘录 |
| `calendar` | `com.apple.iCal`、`com.flexibits.fantastical2.mac` | 日历、Calendar、Fantastical |

`shouldTodoScan` 返回 `enabled && appKind !== null && (lastTodoScanAtMs === null || nowMs - lastTodoScanAtMs >= intervalSec * 1000)`。

**`src/main/screenwatch.ts` 的 `watchTick`**：

- 从 `getSettings()` 多取 `todoScanEnabled`、`todoScanIntervalSec`。
- 在调 `decideOcrTrigger` 前算 `todoScanDue = shouldTodoScan({ enabled: todoScanEnabled, appKind: todoScanAppKind(frontApp, context.bundleId), nowMs: Date.now(), lastTodoScanAtMs, intervalSec: todoScanIntervalSec })`，传进去。
- `trigger.reason === 'todo_scan'` 时更新模块级 `lastTodoScanAtMs = Date.now()`。
- **与 `screenSensePopup` 解耦**：popup 关的语义是「只进记忆不弹卡」，todo-scan 照跑，结果进 `detections`。

触发精度说明：事件门（`activityScanDecision`）在 `decideOcrTrigger` 之前，硬兜底间隔 30-60 秒（默认 45），所以 todo-scan 的实际触发抖动是 ±45 秒。180 秒间隔下可接受，不额外改事件门。

**触发之后的所有既有门原样生效**：pHash 未变 → 跳过；文本 hash 未变 → 跳过；同内容 10 分钟冷却 → 跳过。所以屏幕内容没变化时，todo-scan 一次云端调用都不会花。

**工作记录不重复写**：`OCR_FALLBACK_WORK_REASONS`（`screenwatch.ts:211`）**不加** `'todo_scan'`。这样 `shouldPersistLegacyOcrWork('todo_scan')` 返回 `!historyDerivedWorkActive()` —— History 派生工作记录开着时，todo-scan 顺带拿到的 `work_summary` 不会写成 legacy 记录，避免与 10 分钟摘要派生的记录打架。

**`src/shared/semantic-work.ts`**：`buildSemanticWorkHint` 的 `items:[]` 按决策**不放开**，但要在函数上方补注释说明「items 恒空是有意的：AX 只有 App 名 / 窗口标题 / 焦点角色，抓不到正文里的时间，待办抽取走 todo_scan 的 OCR 通道」——不然下一个人会当成 bug 修，或者反过来以为它在工作。

**新设置**（`types.ts` + `db.ts:getSettings` + `Settings.tsx`）：

| 字段 | 默认 | 读取写法 |
|---|---|---|
| `todoScanEnabled: boolean` | `true` | `map.todoScanEnabled !== 'false'` |
| `todoScanIntervalSec: number` | `180` | `map.todoScanIntervalSec != null ? clamp(60, 600, Number(...)) : 180` |

设置页放在「屏幕感知」一节内，文案写明**会消耗积分**。

### 4.2 B2 — 整份清单的批量识别与批量入库

#### Prompt

`src/main/capture.ts:187` 的 `HINTS` 里抽一个常量：

```ts
const LIST_EXTRACTION_RULES =
  '若内容本身是一份清单或列表（编号列表、复选框列表、会议纪要的 action items、作业/任务列表、待办应用界面），' +
  '逐条提取为独立 item，不要合并成一条，也不要因为条目多就只挑其中一条；' +
  '清单标题或上文里的统一时间（如「本周五前交」）适用于其下所有条目，逐条填进各自的时间字段。'
```

拼进六个 hint：`screen_scan`、`screenshot`、`clipboard_image`、`clipboard_text`、`file`、`text_input`。

现有 `screen_scan` 只有「信息不足或无法确认时不要硬凑，宁可一个都不提取」的保守约束，对清单场景是负作用——补上这段是必要的对冲。

#### 弹卡门（实施时发现的补充）

现有弹卡门是 `extraction.strong`（`screenwatch.ts:412`，即解出了具体时间），弱信号只进「记忆」历史。
这意味着一份没有时间的清单（「买牛奶 / 交作业 / 回邮件」）一条都不会弹，批量卡形同虚设。

改为：**单条候选仍然只有强信号才弹**；当一次识别出 ≥2 条且其中**至少一条解出了具体时间**时，
判定为「清单场景」，整份列出。理由是有一条被时间坐实，这份列表就不是菜单/侧栏噪声。
无时间的条目照样列出但**不预勾**，由用户自己挑——所以放开的是「看见」，不是「自动加入」。

一条时间都没有的内容仍然不弹（不制造新的打扰面），且整体仍在 `screenSensePopup` 开关之下。

#### 批量卡

**`src/renderer/src/pages/PreviewCard.tsx`** 新增 phase：

```ts
| {
    phase: 'batch'
    items: Array<LocalExtraction & { item: ParsedItem; detectionId?: string }>
    sourceText: string
  }
```

- 列出全部候选，每条一个 checkbox，默认勾选 `belongs_to_user !== 'no'` 的。
- 每条显示标题 + 时间（无时间显示「无时间」）；点条目展开看来源片段。
- 底部：**加入选中的 N 条** / **全部忽略**。
- **不走 `screenSenseCardHideSec` 倒计时自动忽略**——`remainMs` 相关逻辑对 `batch` phase 跳过。

**`src/main/screenwatch.ts`**：

- `cards.length >= 2` → `showPreview({ localBatch: { items, sourceText } })`。
- `cards.length === 1` → 保持现在的 `showPreview({ localSuggestion })` 单卡。
- **移除** `cardQueue` / `activeQueuedId` / `enqueueCards` / `showNextQueued` / `onPreviewHidden`，以及 `suggestion.queueIndex` / `queueTotal` 两个字段。
- **`src/main/ipc.ts:215` 与 `:220` 的 `onPreviewHidden()` 调用一并删除**，import 同步清理。
- 桌宠文案保留：`applyExternalPetSay(cards.length > 1 ? \`发现 ${cards.length} 个日程~\` : '发现一个日程~', 'waiting')`。

**新 IPC `suggestion:accept-batch`**（登记进 `ipc-channels.ts`）：

```ts
acceptLocalBatch(payload: {
  entries: Array<{ item: ParsedItem; sourceText: string; detectionId?: string }>
}): { added: number; duplicates: number; titles: string[] }
```

复用 `acceptLocal`（`screenwatch.ts:628`）的入库路径与 `findDuplicateTitle` 查重，逐条走一遍并汇总。卡片回显「✓ 已加入 N 条（M 条重复已跳过）」。

## 5. 模块清单

### 新建

| 文件 | 作用 |
|---|---|
| `src/shared/task-reminder.ts` | 提醒判定纯函数 `dueReminders` |
| `src/main/task-reminder.ts` | 30s tick 调度器 + `powerMonitor` resume 补扫 |
| `src/main/reminder-window.ts` | 置顶提醒卡窗（右上角、不自动关） |
| `src/renderer/src/pages/ReminderCard.tsx` | 提醒卡 UI + 渲染层队列 |
| `src/shared/todo-scan.ts` | 内容型 App 词典 + `shouldTodoScan` |
| `test/task-reminder-smoke.mjs` | 提醒判定单测 |
| `test/todo-scan-smoke.mjs` | App 词典 + 间隔门单测 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `TaskRecord` +3 字段；`AppSettings` +4 设置 |
| `src/shared/ipc-channels.ts` | +6 invoke，+1 event |
| `src/shared/hybrid-history.ts` | `OcrTriggerReason` +`todo_scan`；`OcrTriggerInput` +`todoScanDue`；插入触发分支 |
| `src/shared/semantic-work.ts` | 仅补注释说明 `items:[]` 是有意的 |
| `src/main/db.ts` | `TaskRow`/`rowToTask`/`createTask`/`TASK_EDITABLE` +3 列；+3 个提醒函数；`updateTask` 加提醒状态复位；`getSettings` +4 设置；调 `migrateTaskReminders` |
| `src/main/db-migrations.ts` | +`migrateTaskReminders` |
| `src/main/capture.ts` | 抽 `LIST_EXTRACTION_RULES`，拼进 6 个 hint |
| `src/main/screenwatch.ts` | todo-scan 触发接线；单卡/批量卡分流；删逐张队列 |
| `src/main/pet/controller.ts` | +`applyPetPersistentSay`/`clearPetPersistentSay`，改气泡优先级 |
| `src/main/ipc.ts` | +6 通道；删 `onPreviewHidden` 调用 |
| `src/main/index.ts` | 启停 `startTaskReminder`/`stopTaskReminder` |
| `src/renderer/src/App.tsx` | +`/reminder` 路由 |
| `src/renderer/src/api.ts` | +提醒/批量接受的封装 |
| `src/renderer/src/pages/PreviewCard.tsx` | +`batch` phase；批量卡不倒计时 |
| `src/renderer/src/pages/Settings.tsx` | +「任务提醒」一节；屏幕感知节 +todo-scan 两项 |
| `src/renderer/src/components/TaskDetailModal.tsx` | +提醒字段 |
| `src/renderer/src/components/EditTaskModal.tsx` | +提醒字段 |
| `package.json` | +2 个 `test:*` 脚本，并入 `test:unit` |

## 6. 测试

### 新增单测

**`test/task-reminder-smoke.mjs`** 覆盖 `dueReminders`：
- 全局关 → 空
- 提前量生效（默认 5 分钟）
- 任务级覆盖：`remindOffsetMin = 0` / `30` / `-1`（不提醒）
- 幂等：`remindedAt === targetIso` 不重复；改了 `startTime` 后重新命中
- `pending` / `done` / `ignored` / `belongsToUser !== 'yes'` 不提醒
- 事件时刻口径：`startTime` 优先于 `dueTime`
- 只有日期无时分 → 按 09:00
- 逾期补提醒：1 小时前命中，3 小时前不命中
- snooze：未到不提醒；已到提醒且不受 catchup 窗口限制；**兑现后（`remindedAt === snoozedUntil`）不再重复**
- 复位语义：`remindedAt` / `snoozedUntil` 被清空后，同一任务会重新命中一次
- 排序与 `kind` 取值

**`test/todo-scan-smoke.mjs`** 覆盖：
- `todoScanAppKind` 的 bundleId 精确匹配与 App 名兜底
- 非内容型 App（终端、IDE、设计工具）→ `null`
- `shouldTodoScan` 的间隔门与 `enabled` 门

### 扩充现有单测

- **`test/hybrid-history-smoke.mjs`**：`todoScanDue` 时即使 `semantic=complete` 也 `run: true, reason: 'todo_scan'`；`todoScanDue` 不能绕过 privacy / inactive / screen_unavailable / 全局 cooldown 四道门。
- **`test/ipc-channels-smoke.mjs`**：自动覆盖新通道（三处一致性校验），无需改测试代码，但改错会挂。
- **`test/pet-reaction-smoke.mjs`**：气泡优先级——`persistentSay` 期间 `applyExternalPetSay` 被吞、`setPetScanning` 不动气泡、`clearPetPersistentSay` 后恢复正常。

### 手动验证（真机）

1. 建一个 2 分钟后开始的任务 → 提前 5 分钟设置下应立刻提醒 → 卡片右上角出现、桌宠气泡常驻、系统通知到达；不点不消失。
2. 点「稍后 5 分钟」→ 卡片关、气泡清；5 分钟后再次提醒。
3. 关掉「气泡提醒」总开关 → 卡片与系统通知仍在，桌宠不说话。
4. 合盖 10 分钟再打开 → `resume` 补扫，期间到点的任务被提醒一次（不是多次）。
5. 关机 3 小时后开机 → 超出 2 小时窗口的任务不弹。
5.1 提醒过一次后，把任务时间改到 3 分钟后 → 到点重新提醒（`reminded_at` 已复位）。
5.2 点「稍后 5 分钟」后再点一次「稍后 5 分钟」→ 只在最后一次的时刻提醒，中间不重复弹。
6. 微信里贴一段带 3 条待办的清单 → 3 分钟内出现批量卡，3 条都在，勾选后一次入库。
6.1 清单里只有一条带时间 → 三条都列出，只有带时间那条预勾。
6.2 一条时间都没有的杂乱文本 → 不弹卡（只进「记忆」历史）。
7. 在终端/IDE 里停留 10 分钟 → 不触发 todo-scan（调试面板无 `todo_scan` 事件）。
8. `npm run typecheck && npm run test:unit` 全绿。

## 7. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| todo-scan 抬高截图/OCR/云端频次 → 耗电 + 扣积分 | 180 秒间隔 + 仅内容型 App + pHash/文本 hash/内容冷却三重去重（屏幕没变不花钱） | 关 `todoScanEnabled` 即回到当前行为 |
| 桌宠气泡状态机耦合改坏 → 气泡乱串或提醒气泡被吞 | `persistentSay` 优先级表逐条写单测；改动集中在 `pet/controller.ts` 一个文件 | revert 该文件；提醒卡窗与系统通知不依赖气泡 |
| 提醒刷屏（幂等失效 / 补提醒过多） | 先写 `reminded_at` 再展示；`MAX_CARDS_PER_TICK = 5` + 溢出合并；catchup 窗口 2 小时 | 关 `taskReminderEnabled` |
| DB 加列破坏旧版本 | 纯 additive ALTER，旧版本 `SELECT *` 忽略新列 | 无需回滚 DB；revert 代码后空列无害 |
| 删逐张卡队列引入回归 | `onPreviewHidden` 的两个调用点（`ipc.ts:215/220`）必须一并删干净，否则 import 报错 | revert |
| 提醒卡窗被误当成检测卡，把屏幕感知停死 | 提醒卡是独立窗口，`isPreviewVisible()` 不认它——这正是不复用 preview 窗的原因 | — |

三块功能都在独立开关后面，可分别灰度、分别回滚。

## 8. 实施顺序建议

1. **Part A 骨架**：DB migration + `types.ts` + 纯函数 + 单测（无 UI，可独立验证）
2. **Part A 呈现**：提醒卡窗 + 路由 + IPC + 桌宠气泡优先级 + 设置页
3. **Part B1**：`todo-scan.ts` + `hybrid-history.ts` 分支 + `screenwatch.ts` 接线 + 单测
4. **Part B2**：prompt 常量 + 批量卡 + `accept-batch` + 删逐张队列

每步结束跑 `npm run typecheck && npm run test:unit`。
