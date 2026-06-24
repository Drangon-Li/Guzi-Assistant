# 桌宠整合设计（吸收 openpets 渲染核心进 EShell）

日期：2026-06-24 · 分支：`feat/desktop-pet` · 状态：已批准，进入实现计划

## 1. 目标

把开源桌宠 [openpets](https://github.com/alvinunreal/openpets)（MIT）的桌宠运行时移植进 EShell，**桌宠作为「升级版悬浮助手」替换右下角圆形 FAB**：常驻桌面、会动、点它打开现有助手对话，并对 EShell 的屏幕感知 / 任务事件做出反应（动作 + 气泡）。

用户取向：尽量复刻 openpets 功能，之后审核再删。因此本 spec 定义**完整目标功能集 + 分阶段**，Phase 1 即可用。

## 2. 已确认决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | 桌宠角色 | 替换悬浮助手 FAB（不并存） |
| 2 | 形象 | 先用 openpets 自带 spritesheet，预留可替换 |
| 3 | 设置面板 | 折叠进 EShell 现有「设置」页，不单开 Control Center 窗口 |
| 4 | 气泡 vs 预览卡 | 气泡做 teaser 提醒，现有预览卡仍是可操作面板 |
| 5 | 插件生态 | Phase 1 不做；Phase 2 审核后定 |
| 6 | 实现路线 | 移植 openpets 渲染核心（非从零重写） |

## 3. 授权

- openpets 代码：**MIT**（`worspace/reference/openpets/LICENSE`）。移植需在 EShell 内保留 MIT 版权声明（`src/main/pet/` 顶部 NOTICE 或 `THIRD_PARTY_NOTICES`）。
- `default-pet-spritesheet.webp`：仓库内无单独授权/署名文件 → 受仓库 MIT 覆盖，可用/可改/可再分发。
- `NotoColorEmoji.ttf`：OFL 1.1。**Phase 1 不打包**（气泡不用 emoji 字形）。

## 4. 核心架构决策

桌宠是一个**独立的透明置顶 BrowserWindow**，由主进程移植来的 openpets 运行时**自绘 HTML**渲染（`pet-window` 生成 HTML + `pet-preload.cjs` + `openpets:*` IPC）。**EShell 的 React 渲染层不参与桌宠画面**；EShell 主进程通过移植来的控制器 API（`applyExternalPetReaction/Say`、`showDefaultPet/hideDefaultPet`、move/scale/pause）驱动桌宠。

窗口配置沿用预览卡模板（`windows.ts:51-94`）：`frame:false / transparent:true / alwaysOnTop:true / skipTaskbar:true / hasShadow:false / backgroundThrottling:false`，并 `setAlwaysOnTop(true,'screen-saver')` + `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`。

「点桌宠打开助手」= 桌宠点击 → 主进程 `focusMain('assistant')` → 渲染层 `eshell:navigate` 打开现有 `AssistantChat`（聊天/捕获内核原样保留）。

## 5. 范围

### Phase 1（本次实现，桌宠即升级版悬浮助手）

移植运行时核心到 `src/main/pet/`：
- `pet-motion-engine` `display` `reaction-animation-mapping` `reaction-messages` `plugin-bubble-arbiter` `pet-preload.cjs` `default-pet-controller` `pet-window`（裁剪版）
- 依赖改接：`app-state` → EShell `db`/`getSettings`（桌宠偏好：开关/缩放/位置/反应覆盖）；`i18n.t` → 中文直出（先不做多语言）；`logger` → EShell logger；**剥掉 `plugin-service`/`plugin-sdk-bridge`**（右键菜单换 EShell 精简版，气泡类型内联）
- 资产：`default-pet-spritesheet.webp` 复制到 EShell `resources/pet/`；preload 作为额外入口打包（electron-vite）

功能：透明置顶窗口、9 sprite 状态 + 11 reaction、气泡（transient + arbiter）、点击穿透 hit-test、手动拖拽、多显示器 reclamp、位置持久化（含 per-monitor）、暂停态、缩放（XS/S/M/L/Huge）、反应动画覆盖。重力/物理/follow-cursor/cross-display roaming 默认关、保留开关（openpets 默认也关）。

EShell 侧：
- `windows.ts`：`getPetWindow/showPet/hidePet`（镜像预览卡）
- `index.ts`：启动创建桌宠 + 托盘「显示/隐藏/暂停桌宠」；主窗隐藏不杀桌宠
- `App.tsx:199-206`：移除 `FloatingAssistant` FAB（保留 `chatOpen`/`eshell:navigate` 接线 + `AssistantChat`）
- `ipc-channels.ts`：新增 `eshell:pet`（事件）+ `pet:*`（控制 invoke）通道，3 处一致 + `npm run test:ipc`
- 设置页：桌宠开关/缩放/暂停/重置位置/反应动画覆盖

事件 → 反应映射（驱动点）：

| EShell 事件 | 触发位置 | 反应 |
|---|---|---|
| 屏幕感知命中日程 | `screenwatch.ts:99,380`（`showPreview({localSuggestion})` 旁） | `thinking`/`waiting` + 气泡 teaser |
| 捕获提交 | `capture.ts:302` | `working` |
| 任务完成 | `ipc.ts:113-131`（status→done，需在此区分 payload） | `success`（跳跃） |
| 任务到期 | 日程调度 `dailybrief-scheduler` | `waiting`/`error` + 提醒气泡 |
| 打开助手 | `windows.ts:48` `focusMain('assistant')` | `waving` |

### Phase 2（可选，审核后定）

插件宿主（沙箱 BrowserWindow + ctx surface + 权限 + 配额）、11 个官方插件（番茄钟/喝水/养成/提醒/心情打卡…）、Control Center 独立窗口、多语言 i18n、TTS/语音/音效。

**架构约束**：openpets 插件 `ctx.ai` 是插件 BYOK 直连模型。若 Phase 2 做，`ctx.ai` **必须改走 EShell 的 Supabase Edge 网关 + 积分计费**，禁止插件自带 key 直连（否则绕过计费、扩大密钥暴露面，与「密钥锁服务端」根基冲突）。

### 建议直接 drop（与 EShell 定位冲突/冗余）

终端约束 `confinement-manager`、agent 多宠物 `agent-pet-controller`/租约、`local-ipc` socket + MCP server、Claude Code hooks（`packages/claude`）——这些都是给「Claude Code/终端当桌宠 + 外部进程驱动」的；EShell in-process 直接调控制器，不需要。

## 6. 风险 & 回滚

- **资产路径适配**：openpets 用 `app.getAppPath()`，EShell 是 electron-vite 的 `out/` + `resources/`；preload `.cjs` 需作为额外入口打包并解析正确路径。
- **点击穿透**：macOS 相对稳；openpets 的 Windows rearm hack 可裁剪（EShell 仅 macOS）。
- **两个透明置顶窗口共存**：桌宠 + 预览卡，需避免 z-order/位置打架（桌宠跟随用户拖动位置，预览卡固定右下角）。
- **常驻 ticker**：openpets 单 16ms ticker，hidden/paused 时停——保持该行为，避免空转耗电。
- **IPC 一致性**：新通道走 3 处 + `test:ipc`。
- **回滚**：桌宠为纯新增（窗口 + 通道 + 监听 + `src/main/pet/`），FAB 留在 git 历史。回滚 = 删 pet 窗口/通道、恢复 `FloatingAssistant`。低风险、可逆。本次在 `feat/desktop-pet` 分支，不动 main。

## 7. 验证

- `npm run typecheck`（main + renderer 两个 tsconfig）
- `npm run test:ipc`（通道 3 处一致）
- `npm run test:unit`（既有纯函数单测不回归）
- 真机 smoke（需 macOS 真机）：桌宠显示 / 拖动 / 点击打开助手 / 屏幕感知命中时桌宠反应 + 气泡 / 任务完成时跳跃 / 暂停与缩放生效 / 主窗隐藏后桌宠仍在。

## 8. 无阻塞未决项

授权已清；架构已定；Phase 1 范围明确。Phase 2 仅在用户审核 Phase 1 后启动。
