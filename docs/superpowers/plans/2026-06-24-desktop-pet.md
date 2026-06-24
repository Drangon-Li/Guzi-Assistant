# 桌宠整合 实现计划（Phase 1）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]`。

**Goal:** 把 openpets 桌宠运行时移植进 EShell，桌宠替换右下角悬浮助手 FAB，常驻桌面、会动、点它打开现有助手，并对屏幕感知/任务事件做出反应。

**Architecture:** 桌宠是独立透明置顶 BrowserWindow，由移植到 `src/main/pet/` 的 openpets 运行时自绘 HTML 渲染（`pet-window` 生成 HTML + `pet-preload.cjs` + `openpets:*` IPC）。EShell 主进程通过控制器 API（`applyExternalPetReaction/Say`、`showDefaultPet/hideDefaultPet`、move/scale/pause）驱动。React 渲染层不参与桌宠画面。

**Tech Stack:** Electron 38 · electron-vite · TypeScript · better-sqlite3（桌宠偏好持久化）。源工程：`worspace/reference/openpets/apps/desktop/`（MIT）。

## Global Constraints

- 仅 macOS；桌宠窗口须 `frame:false / transparent:true / alwaysOnTop:true / skipTaskbar:true / hasShadow:false / backgroundThrottling:false` + `setAlwaysOnTop(true,'screen-saver')` + `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`。
- IPC 新通道必须 3 处一致（`src/shared/ipc-channels.ts` ↔ `src/main/ipc.ts` handler ↔ `src/renderer/src/api.ts` wrapper），`npm run test:ipc` 必过。
- 移植代码保留 openpets MIT 版权声明（`src/main/pet/THIRD_PARTY_NOTICES.md`）。
- 资产 `default-pet-spritesheet.webp` 放 `resources/pet/`，运行时按 electron-vite 的 `out/`+`resources/` 路径解析，不用 `app.getAppPath()` 硬编码。
- 不打包 NotoColorEmoji；气泡不用 emoji 字形。
- Phase 1 不移植：plugin host、Control Center、`confinement-manager`、`agent-pet-controller`、`local-ipc` socket、MCP、Claude hooks。
- 每个里程碑结束 `npm run typecheck` 必过；纯逻辑模块加 `test/*-smoke.mjs`；窗口/GUI 任务以 typecheck + test:ipc + 真机 smoke 验证。
- 全程在 `feat/desktop-pet` 分支；频繁 commit；不 push（需用户批准）。

---

## M0 — 脚手架与资产

### Task 0.1: 目录、资产、第三方声明
**Files:**
- Create: `src/main/pet/THIRD_PARTY_NOTICES.md`（openpets MIT 全文 + 来源 URL）
- Copy: `worspace/reference/openpets/apps/desktop/assets/default-pet-spritesheet.webp` → `resources/pet/default-pet-spritesheet.webp`
- Modify: `electron.vite.config.ts`（把 `pet-preload.cjs` 加为额外 preload 入口；确认 `resources/` 随包）

- [ ] Step 1: 建 `src/main/pet/`，写 `THIRD_PARTY_NOTICES.md`（含 openpets MIT 文本）
- [ ] Step 2: 复制 spritesheet 到 `resources/pet/`
- [ ] Step 3: 读 `electron.vite.config.ts` 现有 main/preload/renderer 配置，加 pet-preload 入口（参考现有 `src/preload/index.ts` 的打包方式）
- [ ] Step 4: 验证 `npm run typecheck` 通过；`ls out/` 确认 preload 产物
- [ ] Step 5: Commit `chore(pet): 脚手架 + spritesheet 资产 + 第三方声明`

### Task 0.2: 资产路径解析 helper
**Files:**
- Create: `src/main/pet/paths.ts`
**Interfaces:**
- Produces: `petAsset(name: string): string`（dev 用 `resources/pet/`，prod 用打包后路径）；`petPreloadPath(): string`；`petUserDataDir(): string`（`app.getPath('userData')/pet`）

- [ ] Step 1: 参考 `windows.ts` 里 `load()` 对 dev/prod 路径的判断，写 `paths.ts` 三个函数
- [ ] Step 2: `npm run typecheck`
- [ ] Step 3: Commit `feat(pet): 资产/preload 路径解析`

---

## M1 — 纯逻辑模块移植（带 smoke 测试）

这些是 openpets 里耦合最轻、可单测的：reaction 映射、消息池、气泡仲裁、运动数学、显示器 clamp。移植为 EShell 风格（无 app-state 依赖，纯函数/纯类）。

### Task 1.1: reaction 映射 + 消息池
**Files:**
- Create: `src/main/pet/reaction-mapping.ts`（移植 `reaction-animation-mapping.ts`：9 sprite 状态表 + 11 reaction→sprite 映射 + `resolveReactionSpriteState`）
- Create: `src/main/pet/reaction-messages.ts`（移植中文消息池；`pickReactionMessage(reaction)`）
- Test: `test/pet-reaction-smoke.mjs`

- [ ] Step 1: 写 `test/pet-reaction-smoke.mjs`：断言 11 个 reaction 都能 `resolveReactionSpriteState` 出合法 sprite 行；`success→jumping`、`error→failed`、`idle→idle`；`pickReactionMessage` 返回非空串
- [ ] Step 2: `node test/pet-reaction-smoke.mjs` 预期 FAIL（模块不存在）
- [ ] Step 3: 移植 `reaction-mapping.ts` + `reaction-messages.ts`（中文台词，去 i18n 依赖）
- [ ] Step 4: `node test/pet-reaction-smoke.mjs` 预期 PASS；把它加进 `package.json` 的 `test:unit` 串
- [ ] Step 5: Commit `feat(pet): reaction 映射与中文消息池 + smoke`

### Task 1.2: 气泡仲裁器
**Files:**
- Create: `src/main/pet/bubble-arbiter.ts`（移植 `plugin-bubble-arbiter.ts`：transient 优先队列 low/normal/high/urgent、max 16、相邻同文 coalesce、sticky/urgent 不打断；pinned 单槽；`show/handleDismissed/clearPlugin`）
- Test: `test/pet-bubble-smoke.mjs`

- [ ] Step 1: 写 smoke：入队 3 条不同优先级 → 先出 urgent；相邻同文合并；满 16 截断
- [ ] Step 2: 跑预期 FAIL
- [ ] Step 3: 移植 arbiter（去掉 plugin 概念，保留 slot/priority/coalesce 逻辑）
- [ ] Step 4: 跑预期 PASS；加进 `test:unit`
- [ ] Step 5: Commit `feat(pet): 气泡仲裁器 + smoke`

### Task 1.3: 运动引擎 + 显示器 clamp
**Files:**
- Create: `src/main/pet/motion-engine.ts`（移植 `pet-motion-engine.ts`：单 16ms ticker、单写者、`motionMoveTo/motionSetFollowCursor/motionSetPhysics/motionStop`、亚像素累加；hidden/dragging 暂停）
- Create: `src/main/pet/display.ts`（移植 `display.ts`：`deriveDisplayKey`、`clampToNearestDisplayIfOffscreen`、workArea clamp）
- Test: `test/pet-motion-smoke.mjs`

- [ ] Step 1: 写 smoke：纯函数部分——`clampToNearestDisplayIfOffscreen` 把越界点拉回最近显示器；`deriveDisplayKey` 稳定；moveTo 的插值步进（抽出可测的纯计算）
- [ ] Step 2: 跑预期 FAIL
- [ ] Step 3: 移植（ticker 的 `electron` 依赖 lazy-require；纯计算与副作用分离便于测）
- [ ] Step 4: 跑预期 PASS；加进 `test:unit`
- [ ] Step 5: Commit `feat(pet): 运动引擎与显示器 clamp + smoke`

---

## M2 — 桌宠窗口（能开、能动画）

### Task 2.1: 桌宠 preload
**Files:**
- Create: `src/main/pet/pet-preload.cjs`（移植 `pet-preload.cjs`：hit-test 上报、drag mousedown/move/up、`openpets:*` 收发、sprite/motion 状态应用、audio/tts 先保留接口可空实现）

- [ ] Step 1: 移植 preload，频道名沿用 `openpets:*`；裁掉 plugin/voice 复杂部分，保留 hit-test/drag/motion/reaction/bubble
- [ ] Step 2: `npm run typecheck`（cjs 不入 ts 检查，确认打包入口正确）
- [ ] Step 3: Commit `feat(pet): 桌宠窗口 preload`

### Task 2.2: 桌宠窗口生成（HTML/CSS）+ stub 依赖
**Files:**
- Create: `src/main/pet/pet-window.ts`（移植 `pet-window.ts` 的：base window 创建、`createPetWindowCss`、sprite CSS（`--sprite-row-y`/steps）、HTML 生成与 `loadFile`、hit-test handler、drag handler、motion 状态发布、`setPetReactionState/setPetWindowScale`）
- Create: `src/main/pet/state.ts`（stub `app-state`：从 EShell `getSettings()`/`db` 读写桌宠偏好——`petScale`、`reactionOverrides`、位置 flat + per-monitor map；`paused` 标志）
- Modify: `src/main/db.ts`（如需，加 `pet` 偏好的存取；或复用 `settings` KV）

**Interfaces:**
- Produces: `createPetWindow(): BrowserWindow`；`setPetReactionState(win, sprite)`；`setPetWindowScale(win, scale)`；`getPetPrefs()/savePetPrefs(patch)`

- [ ] Step 1: 写 `state.ts`：桌宠偏好走 EShell `settings` KV（key `pet.*`），含 scale/overrides/position/perMonitor/paused 的 get/set
- [ ] Step 2: 移植 `pet-window.ts`，把 openpets 对 `app-state`/`i18n`/`plugin-service` 的 import 改为：`state.ts`、中文常量、删除 plugin 菜单（右键菜单先留「打开助手 / 隐藏桌宠 / 暂停」三项）
- [ ] Step 3: sprite/资产路径用 `paths.petAsset(...)`；preload 用 `paths.petPreloadPath()`
- [ ] Step 4: `npm run typecheck`
- [ ] Step 5: **真机 smoke**：临时在 `index.ts` 调一次 `createPetWindow()` → 桌宠出现在桌面、idle 动画在跑、透明无边框置顶。记录结果
- [ ] Step 6: Commit `feat(pet): 桌宠窗口生成 + 偏好 stub（能显示+idle 动画）`

---

## M3 — 控制器与交互

### Task 3.1: 默认桌宠控制器
**Files:**
- Create: `src/main/pet/controller.ts`（移植 `default-pet-controller.ts` 的核心：`showDefaultPet/hideDefaultPet`、`setDefaultPetPaused/getDefaultPetPaused`、`applyExternalPetReaction(reaction,{showMessage?})`、`applyExternalPetSay(message,reaction?)`、`applyExternalPetStatusReaction`、move/wander/moveToHome、`resetDefaultPetToInitialPosition`、`destroyDefaultPet`；位置持久化用 `state.ts`；多显示器 reclamp 用 `display.ts`；去掉 plugin-events-source / agent-pet）

**Interfaces:**
- Produces: 上述控制器函数（这是 EShell 事件层唯一调用面）

- [ ] Step 1: 移植 controller，接 `pet-window.ts` + `motion-engine.ts` + `display.ts` + `bubble-arbiter.ts` + `state.ts`
- [ ] Step 2: `npm run typecheck`
- [ ] Step 3: 真机 smoke：在 `index.ts` 临时按键/定时调用 `applyExternalPetReaction('success')`、`applyExternalPetSay('你好~')` → 桌宠跳跃 + 气泡；`setDefaultPetPaused(true)` → 变暗冻结
- [ ] Step 4: Commit `feat(pet): 桌宠控制器（reaction/say/pause/move）`

### Task 3.2: 拖拽 + 点击穿透 + 多显示器
**Files:**
- Modify: `src/main/pet/pet-window.ts`（hit-test → `setIgnoreMouseEvents`；drag handler → `setBounds`；裁掉 Windows rearm，仅留 macOS 路径）
- Modify: `src/main/pet/controller.ts`（display-added/removed/metrics-changed reclamp + per-monitor 位置恢复）

- [ ] Step 1: 接好 hit-test：命中 `.pet-hitbox/.bubble` 才交互，否则点击穿透
- [ ] Step 2: 接好拖拽：拖动改 bounds + 防抖持久化位置（flat + per-monitor）
- [ ] Step 3: 接 `screen` 的 display 事件 → reclamp
- [ ] Step 4: `npm run typecheck`
- [ ] Step 5: 真机 smoke：拖动桌宠、桌宠空白处点击穿透到下层、拔插/切换显示器位置不丢
- [ ] Step 6: Commit `feat(pet): 拖拽/点击穿透/多显示器`

---

## M4 — EShell 集成（替换 FAB + 通道 + 生命周期）

### Task 4.1: 窗口管理接口
**Files:**
- Modify: `src/main/windows.ts`（加 `getPetWindow()/showPet()/hidePet()/isPetVisible()`，镜像 `getPreviewWindow/showPreview/hidePreview`；模块级 `petWin` 单例）

- [ ] Step 1: 加 pet 窗口三件套（沿用预览卡的透明置顶 + backgroundThrottling:false + visibleOnAllWorkspaces 配方，但实际窗口由 `pet-window.createPetWindow` 产出，windows.ts 只持有单例与 show/hide）
- [ ] Step 2: `npm run typecheck`
- [ ] Step 3: Commit `feat(pet): windows.ts 桌宠窗口接口`

### Task 4.2: IPC 通道（3 处一致）
**Files:**
- Modify: `src/shared/ipc-channels.ts`（`EVENT_CHANNELS` 加 `eshell:pet`；`INVOKE_CHANNELS` 加 `pet:set-enabled` `pet:set-scale` `pet:set-paused` `pet:reset-position` `pet:set-reaction-override`）
- Modify: `src/main/ipc.ts`（对应 5 个 `ipcMain.handle` → 调 controller/state）
- Modify: `src/renderer/src/api.ts`（5 个 `inv<>()` wrapper）

- [ ] Step 1: 三处同步加通道 + handler + wrapper
- [ ] Step 2: `npm run test:ipc` 预期 PASS（精确相等）
- [ ] Step 3: `npm run typecheck`
- [ ] Step 4: Commit `feat(pet): 桌宠 IPC 通道（3 处一致）`

### Task 4.3: 替换悬浮助手 FAB + 点击打开助手
**Files:**
- Modify: `src/renderer/src/App.tsx:199-206`（移除 `<FloatingAssistant>` FAB 渲染；保留 `chatOpen` state + `eshell:navigate→setChatOpen` 接线 + 把 `AssistantChat` 改挂在一个由 `chatOpen` 控制的轻面板里，或复用原 panel 容器去掉 FAB 按钮）
- Modify: `src/main/index.ts`（启动 `getPetWindow()`；托盘加「显示/隐藏桌宠」「暂停/恢复桌宠」；`window-all-closed`/`activate` 不影响桌宠存活）
- Modify: `src/main/pet/pet-window.ts` 右键菜单「打开助手」→ `focusMain('assistant')`

**Interfaces:**
- Consumes: `focusMain('assistant')`（`windows.ts:44-49`，触发 `eshell:navigate`）

- [ ] Step 1: App.tsx 去掉 FAB，保留聊天面板 + 现有 navigate 接线（点桌宠 → focusMain('assistant') → 面板打开）
- [ ] Step 2: index.ts 启动创建桌宠 + 托盘项 + 生命周期
- [ ] Step 3: 桌宠点击（hit-test click 事件）→ `focusMain('assistant')`
- [ ] Step 4: `npm run typecheck` + `npm run test:ipc`
- [ ] Step 5: 真机 smoke：FAB 消失；点桌宠弹出助手对话；主窗隐藏后桌宠仍在；托盘能显隐/暂停桌宠
- [ ] Step 6: Commit `feat(pet): 桌宠替换悬浮助手 FAB + 点击打开助手`

---

## M5 — 事件 → 反应联动

### Task 5.1: 屏幕感知 / 捕获 / 任务 / 助手 事件驱动桌宠
**Files:**
- Modify: `src/main/screenwatch.ts:99,380`（`showPreview({localSuggestion})` 旁：`applyExternalPetReaction('thinking')` + `applyExternalPetSay('发现一个日程~','waiting')`）
- Modify: `src/main/capture.ts:302`（捕获提交结果旁：`applyExternalPetReaction('working')`）
- Modify: `src/main/ipc.ts:113-131`（`tasks:update` status→done 时 `applyExternalPetReaction('success')`；到期由 `dailybrief-scheduler` fire 时 `applyExternalPetReaction('waiting')` + say 提醒）
- Modify: `src/main/windows.ts:48`（`focusMain('assistant')` 时 `applyExternalPetReaction('waving')`）

- [ ] Step 1: 在上述 4 处事件源调用 controller（直接 in-process 调，不必经 `eshell:pet` 广播——`eshell:pet` 仅在渲染层需要感知时用）
- [ ] Step 2: 区分 task 完成 vs 创建（在 `tasks:update` handler 内判断 status 变化）
- [ ] Step 3: `npm run typecheck` + `npm run test:unit`（确保既有逻辑不回归）
- [ ] Step 4: 真机 smoke：屏幕感知命中 → 桌宠 thinking + 气泡；勾完成任务 → 跳跃；捕获 → working；开助手 → waving
- [ ] Step 5: Commit `feat(pet): 屏幕感知/捕获/任务/助手 事件驱动桌宠反应`

---

## M6 — 设置页

### Task 6.1: 桌宠设置项
**Files:**
- Modify: `src/renderer/src/pages/Settings.tsx`（加「桌宠」分区：启用开关、缩放 XS/S/M/L/Huge、暂停、重置位置、每 reaction 动画覆盖下拉）
- Consumes: `api.pet*` wrappers（Task 4.2）

- [ ] Step 1: 加桌宠设置 UI，绑 `pet:*` invoke
- [ ] Step 2: `npm run typecheck`
- [ ] Step 3: 真机 smoke：改缩放/暂停/重置即时生效并持久化（重启保留）
- [ ] Step 4: Commit `feat(pet): 设置页桌宠分区`

---

## M7 — 收尾验证

- [ ] `npm run typecheck`（main + renderer）全过
- [ ] `npm run test:unit` + `npm run test:ipc` 全过
- [ ] 真机 smoke 清单逐项过（显示/拖动/穿透/点击开助手/屏幕感知反应/任务完成跳跃/暂停/缩放/多显示器/主窗隐藏后存活）
- [ ] 更新 README「界面」「目录结构」补桌宠
- [ ] 移除各 milestone 里的临时 smoke 触发代码
- [ ] Commit `docs(pet): README 补桌宠` + 汇总

## Self-Review 覆盖

spec 第 5 节 Phase 1 全部条目 → M0-M6 均有对应任务；授权（spec §3）→ Task 0.1 NOTICE；事件映射（spec §5 表）→ Task 5.1；回滚（spec §6）→ 全程分支 + 纯新增。Phase 2 / drop 项不在本计划（spec 已界定）。
